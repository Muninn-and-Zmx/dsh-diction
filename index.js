/**
 * 遣词造句（dsh-diction）—— 让 AI 说话像使用者本人。
 *
 * 一件东西：
 * - **一段常驻提示词**：把使用者写下的「情景 / 身份 / 我会怎么说」样本注入系统提示，
 *   每轮组装都在。它只管「怎么说」，不碰判断、不碰人格。
 *
 * 样本存在 `$DSH_HOME/dsh-diction.json`，面板（插件详情页）通过 RPC 读写；
 * 改完下一句消息就生效，不用重启——只有改这个文件的代码才要重启宿主。
 *
 * 为什么不在这里做「提炼」：样本是使用者的原话，中间过一道模型反而会失真；
 * 直接注入最贴近，也省掉每轮一次额外的模型调用。
 *
 * 段为什么要按 agent 注册：全局段在热加载时会残留旧的一份，按会话注册的段
 * 随会话释放一起撤销，不会越积越多。拿不到 scoped 注册时宁可不注入。
 */

import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { randomUUID } from 'node:crypto';
import {
  BAN_GROUPS,
  emptyBans,
  hasBans,
  banPatterns,
  matchBans,
  matchStructure,
  normalizeBans,
  normalizeConversations,
} from './samples.js';
import { SECTION_NAME, renderDiction } from './text.js';

/** Loader row id，同时是这个插件在 patch 里的 id。 */
export const name = 'diction';

/** 只有提示词注册表是硬依赖；webServer 拿不到时插件照常注入，只是没有面板。 */
export const inject = ['systemPrompt'];

/** 数据文件名（`$DSH_HOME` 下）。 */
export const DATA_FILE = 'dsh-diction.json';

/** 详情页面板的 RPC 前缀。 */
export const RPC_CHANNEL = '/dsh-diction';

/** 数据格式版本，留给以后迁移。 */
const DATA_VERSION = 1;

/** `$DSH_HOME`：优先环境变量，退回 `~/.dsh`。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return fromEnv || path.join(homedir(), '.dsh');
}

/**
 * 一份全新的数据：初始十景，回答全空。
 *
 * @param {object} [config] Loader row config
 */
function freshData(config = {}) {
  return {
    version: DATA_VERSION,
    enabled: config.enabled !== false,
    conversations: [],
    bans: emptyBans(),
  };
}

/** 把磁盘上的东西收拾成能用的样子：坏掉的字段一律退回默认，不抛。 */
function readData(raw, fallback) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  const conversations = normalizeConversations(raw.conversations);
  const bans = normalizeBans(raw.bans);
  return {
    version: DATA_VERSION,
    enabled: raw.enabled !== false,
    conversations: conversations.ok ? conversations.conversations : fallback.conversations,
    bans: bans.ok ? bans.bans : fallback.bans,
  };
}

/**
 * 宿主半。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] Loader row config（cordis.patch.yml 里的 config）
 */
export async function apply(ctx, config = {}) {
  const home = dshHome();
  const dataFile = path.join(home, DATA_FILE);
  const warn = (message) => ctx.logger?.warn?.(`[diction] ${message}`);
  const order = Number.isFinite(Number(config.order)) ? Number(config.order) : 201;

  /** 当前生效的数据。文件一变就整体换掉，段里读的永远是这一份。 */
  let data = freshData(config);
  /** 上次读文件时的 mtime，用来判断要不要重读。 */
  let dataMtimeMs = -1;
  /** 文件坏过一次就别每句都刷屏。 */
  let warnedBadFile = false;

  /** 注册过段却拿不到 systemPrompt 的会话，只记一次日志。 */
  const degraded = new Set();
  /** 每个会话只注册一次段。 */
  const registered = new Set();

  /** 原子写回数据文件。 */
  const writeData = async (next) => {
    await mkdir(home, { recursive: true });
    const tmp = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, dataFile);
    data = next;
    dataMtimeMs = -1;
    return next;
  };

  /**
   * 读一遍数据文件，必要时更新 `data`。只在消息到达 / 面板读写时调用（低频），
   * 所以改完文件下一句就生效，又不会每次组装都碰磁盘。
   */
  const refresh = () => {
    let mtimeMs;
    try {
      mtimeMs = statSync(dataFile).mtimeMs;
    } catch (error) {
      // 文件被删了就保持现状，不复活初始样本——删是使用者的决定。
      if (error?.code !== 'ENOENT') warn(`stat ${dataFile} failed: ${String(error)}`);
      return data;
    }
    if (mtimeMs === dataMtimeMs) return data;
    try {
      const raw = JSON.parse(readFileSync(dataFile, 'utf8'));
      data = readData(raw, freshData(config));
      dataMtimeMs = mtimeMs;
      warnedBadFile = false;
    } catch (error) {
      if (!warnedBadFile) {
        warn(`data file unreadable, keeping previous data: ${String(error)}`);
        warnedBadFile = true;
      }
    }
    return data;
  };

  /** 第一次运行时把初始十景落盘，面板里才有东西可填。 */
  const ensureFile = async () => {
    try {
      statSync(dataFile);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') return;
    }
    try {
      await writeData(freshData(config));
    } catch (error) {
      warn(`could not create ${dataFile}: ${String(error)}`);
    }
  };

  /** 某个会话该注入的文本。关掉、或一段对话一条禁令都没有，都返回空串（整段消失）。 */
  const renderFor = () => renderDiction({
    enabled: data.enabled,
    conversations: data.conversations,
    bans: data.bans,
  });

  /** 给一个会话注册它自己的段。失败就降级为「不注入」，并记一行。 */
  const registerSection = (agent) => {
    if (!agent || typeof agent.id !== 'string') return;
    if (registered.has(agent.id)) return;
    let registry;
    try {
      registry = typeof agent.ctx?.get === 'function' ? agent.ctx.get('systemPrompt') : undefined;
    } catch {
      registry = undefined;
    }
    if (!registry || typeof registry.section !== 'function') {
      if (!degraded.has(agent.id)) {
        degraded.add(agent.id);
        warn(`no scoped systemPrompt for ${agent.id}; no injection for this session`);
      }
      return;
    }
    try {
      agent.ctx.effect(
        () =>
          registry.section({
            name: SECTION_NAME,
            order,
            text: () => renderFor(),
            interpolate: false,
          }),
        'dsh-diction.section()',
      );
      registered.add(agent.id);
    } catch (error) {
      if (!degraded.has(agent.id)) {
        degraded.add(agent.id);
        warn(`section registration failed for ${agent.id}: ${String(error)}`);
      }
    }
  };

  // 每个会话一条自己的段。
  ctx.on('agent/created', ({ agent } = {}) => {
    registerSection(agent);
  });

  /**
   * 这一轮已经说出去的话。禁令检查靠它——`agent/turn-stopping` 时能拿到，
   * 才谈得上「当场退回重说」。按会话存，新一条用户消息进来就清空。
   */
  const said = new Map(); // agentId -> { text, checkedTurn }

  /** 这一轮有没有在 pre-step 递过提醒（按 agent 记 turn）。 */
  const hinted = new Map();

  /** 一条禁令在正文里出现几次（字面 + 通配都算）。 */
  const countOccurrences = (text, ban) => {
    let total = 0;
    for (const pattern of banPatterns(ban)) {
      try {
        total += (text.match(new RegExp(pattern, 'gi')) ?? []).length;
      } catch { /* 坏模式跳过 */ }
    }
    return Math.max(total, 1);
  };

  /** 命中的禁令记录，面板展示用；只留最近 50 条。 */
  const hits = [];

  /** 每个会话最近一次命中发生在哪一轮。 */
  const lastHitTurn = new Map();

  // 消息进来时刷一次数据：改完文件，下一句就按新的说；顺带清掉上一轮的话。
  ctx.on('agent/inbox/inserted', ({ agent } = {}) => {
    refresh();
    if (agent && typeof agent.id === 'string') {
      const buf = said.get(agent.id);
      if (buf) {
        buf.text = '';
        buf.checkedTurn = null;
      }
      hinted.delete(agent.id);
    }
  });

  // 攒这一轮说出去的正文。工具调用、图片之类不算：禁令盯的是说出来的话。
  //
  // ⚠️ `session/event` 是**两个位置参数**（session, event），不是对象 payload——
  // 2026-11-24 因为按对象解构，这个监听从来没收到过东西，禁令也就从来没真拦过。
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (typeof id !== 'string' || !registered.has(id)) return;
    if (event?.type !== 'assistant/message') return;
    const content = event?.data?.message?.content;
    if (!Array.isArray(content)) return;
    const text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text === '') return;
    let buf = said.get(id);
    if (!buf) {
      buf = { text: '', checkedTurn: null };
      said.set(id, buf);
    }
    buf.text = buf.text === '' ? text : `${buf.text}\n${text}`;
  });

  /**
   * 禁令检查：只看，不拦。
   *
   * 2026-11-25 他定的：不要退回重写，改成「检查 + 提醒 + 记录」——
   * 命中的条目记进 `hits`，面板上摆给使用者看，由他自己决定要不要改禁令或补样本；
   * 已经说出去的话不再被拽回来。
   */
  ctx.on('agent/turn-stopping', ({ agent, turn } = {}) => {
    if (!agent || typeof agent.id !== 'string') return;
    if (data.enabled === false) return;
    if (!hasBans(data.bans)) return;

    const buf = said.get(agent.id);
    if (!buf || buf.text.trim() === '') return;
    if (buf.checkedTurn === turn) return;

    const bufText = buf.text;
    const merged = [...matchBans(bufText, data.bans), ...matchStructure(bufText, data.bans)];
    // 同一条禁令可能既字面命中又结构命中，只报一次。
    const unique = merged.filter((hit, index) => merged.findIndex((item) => item.ban === hit.ban) === index);

    buf.checkedTurn = turn;
    buf.text = '';
    if (unique.length === 0) return;

    const at = new Date().toISOString();
    for (const hit of unique) {
      hits.push({
        at,
        turn,
        group: hit.group,
        label: hit.label,
        ban: hit.ban,
        // 同一句话里同一条规则出现几次（2026-11-26 他要的：次数和记录分开看）
        count: countOccurrences(bufText, hit.ban),
        snippet: hit.snippet.replace(/\s+/g, ' ').slice(0, 60),
      });
    }
    // 只留最近 50 条，面板看的是这个；再长就成了长期占内存。
    if (hits.length > 50) hits.splice(0, hits.length - 50);
    // 下一轮开口前提醒一句：上一轮命中过，不用改，只是个提示。
    lastHitTurn.set(agent.id, turn);
  });

  /**
   * 每一步开始前，把「照样本说 + 禁令清单」递到眼前。
   *
   * 2026-11-25 他要的效果：系统提示里那段整轮只组装一次，调几个工具之后就离得远了；
   * 这条是生成前的最后一句。他和言外之意约定的次序是**先言外之意、后遣词造句**——
   * 先读懂这句话什么意思，再决定怎么说。两条的先后靠插件加载顺序实现
   * （profile 的 bundles 里 dsh-subtext 排在 dsh-diction 前面）。
   */

  ctx.on('agent/pre-step', async (payload, next) => {
    refresh();
    const decision = await next();

    const agent = payload?.agent;
    if (!agent || typeof agent.id !== 'string') return decision;
    if (data.enabled === false) return decision;
    if (hinted.get(agent.id) === payload.turn) return decision;
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;

    const hasConversations = data.conversations.some((item) => item.a.trim() !== '' || item.b.trim() !== '');
    const hasBansNow = hasBans(data.bans);
    if (!hasConversations && !hasBansNow) return decision;

    const lines = [];
    if (hasConversations) lines.push('开口之前先照样本 B 的说法讲。');
    if (hasBansNow) {
      lines.push('先扫一遍下面这些禁令，命中的话换一种讲法，别只改排版：');
      for (const group of BAN_GROUPS) {
        const items = (data.bans[group.key] ?? []).filter((item) => item.trim() !== '');
        if (items.length > 0) lines.push(`- ${group.label}：${items.join('；')}`);
      }
    }
    lines.push('还在干活的，先把活干完；准备开口时再想这一遍。');
    const lastTurn = lastHitTurn.get(agent.id);
    if (typeof lastTurn === 'number' && payload.turn - lastTurn <= 1) {
      lines.push('上一轮有内容踩到禁令，已经记在详情页里，不用回头改，这一轮留意一下。');
    }

    hinted.set(agent.id, payload.turn);
    return {
      ...decision,
      messages: [
        ...decision.messages,
        {
          role: 'user',
          content: [{ type: 'text', text: lines.join('\n') }],
          id: randomUUID(),
          source: { kind: 'diction' },
        },
      ],
    };
  });

  // 会话走了，清掉记账。
  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (!agent || typeof agent.id !== 'string') return;
    registered.delete(agent.id);
    said.delete(agent.id);
    hinted.delete(agent.id);
    degraded.delete(agent.id);
  });

  // ---- 详情页的读写接口 ----
  //
  // 浏览器写不了文件，所以给一个最小 RPC：读全部样本、存面板改过的东西。
  // 路由挂在 webServer 上：connection.rpc.handle 走的是 service provider 的 ctx，
  // 那边拿不到 webServer，直接开前缀路由反而稳。

  /** 面板要的东西：路径、开关、全部对话、上限、已填条数、禁令。 */
  const view = () => ({
    path: dataFile,
    enabled: data.enabled,
    conversations: data.conversations,
    hits: hits.slice(-20).reverse(),
    filled: data.conversations.filter((item) => item.a.trim() !== '' || item.b.trim() !== '').length,
    bans: data.bans,
  });

  const handleRpc = async (endpoint, payload) => {
    try {
      refresh();
      if (endpoint === 'get') return { ok: true, value: view() };

      if (endpoint === 'clear') {
        hits.length = 0;
        lastHitTurn.clear();
        return { ok: true, value: view() };
      }

      if (endpoint === 'save') {
        const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
        const bad = (message) => ({ ok: false, error: { code: 'diction/bad-request', message } });
        const patch = {};
        // 两个键各自可选：面板只传动过的那几项，免得顺手把没动的东西写掉。
        if (body.conversations !== undefined) {
          const normalized = normalizeConversations(body.conversations);
          if (!normalized.ok) return bad(normalized.error);
          patch.conversations = normalized.conversations;
        }
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') return bad('enabled 必须是布尔值');
          patch.enabled = body.enabled;
        }
        // 禁令：不设条数上限，只限单条长度。
        if (body.bans !== undefined) {
          const normalized = normalizeBans(body.bans);
          if (!normalized.ok) return bad(normalized.error);
          patch.bans = normalized.bans;
        }
        if (Object.keys(patch).length === 0) return bad('没有要保存的内容');
        await writeData({ ...data, ...patch });
        return { ok: true, value: view() };
      }

      return { ok: false, error: { code: 'diction/unknown-endpoint', message: `unknown endpoint: ${endpoint}` } };
    } catch (error) {
      return { ok: false, error: { code: 'diction/failed', message: String(error?.message ?? error) } };
    }
  };

  const MAX_BODY_BYTES = 1024 * 1024;
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readJsonBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return undefined;
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return undefined;
    }
  };

  // webServer 是可选依赖：用 cordis 的 inject 等它就绪再挂路由。
  // 别用 `ctx.get('webServer')` 直接拿——未声明注入的服务取不到，外面打进来就是 405。
  const registrar = typeof ctx.inject === 'function'
    ? (deps, callback) => ctx.inject(deps, callback)
    : typeof ctx.registry?.inject === 'function'
      ? (deps, callback) => ctx.registry.inject(deps, callback)
      : null;

  if (registrar) {
    registrar(['webServer'], (web) => {
      const route = {
        kind: 'prefix',
        path: RPC_CHANNEL,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://diction');
          const prefix = `${RPC_CHANNEL}/`;
          const endpoint = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
          if (req.method !== 'POST' || endpoint === '' || endpoint.includes('/')) {
            res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end('not found');
            return;
          }
          const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (contentType !== 'application/json') {
            res.writeHead(415, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end('content type must be application/json');
            return;
          }
          const envelope = await readJsonBody(req);
          if (envelope === undefined || typeof envelope?.rpcId !== 'string' || typeof envelope?.method !== 'string') {
            res.writeHead(400, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end('invalid rpc envelope');
            return;
          }
          if (envelope.method !== endpoint) {
            sendJson(res, 200, {
              type: 'server-response',
              rpcId: envelope.rpcId,
              result: {
                ok: false,
                error: {
                  code: 'gateway/bad-request',
                  message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
                },
              },
            });
            return;
          }
          const result = await handleRpc(endpoint, envelope.payload);
          sendJson(res, 200, { type: 'server-response', rpcId: envelope.rpcId, result });
        },
      };
      try {
        web.effect(() => web.webServer.register(route), 'dsh-diction.rpc()');
      } catch (error) {
        warn(`rpc route registration failed: ${String(error)}`);
      }
    });
  } else {
    warn('no ctx.inject; plugin-detail RPC unavailable on this host');
  }

  // 启动时先读一次文件（有的话）；没有就落一份初始十景。
  await ensureFile();
  refresh();

  // 热加载时已经有会话在跑，`agent/created` 不会重放，这里补一遍。
  // 冷启动时列表是空的，什么都不做。
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const live = typeof agents?.list === 'function' ? agents.list() : [];
    for (const agent of live) registerSection(agent);
  } catch {
    // 拿不到列表就算了，等下一个 agent/created
  }
}
