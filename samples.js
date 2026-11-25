/**
 * 遣词造句的样本层：**对话样本** + **禁令**。
 *
 * 对话样本只有两句话：A 是我听到的（对方说的、或一个场合里砸过来的那一句），
 * B 是我会怎么接。不设情景、不设身份——那些是插件替我编的，不是我说的，
 * 编得再像也是假的。只有 A 和 B 是我自己写下来的原话。
 *
 * 这里只做纯函数：清洗、编号、上限、匹配，方便逐条单测。
 */

/** A、B 各自的字数上限。超了直接报错，不静默截断——截断等于替他改话。 */
export const MAX_LINE_CHARS = 1000;

/** 一条空对话。每次调用都新建，谁改都不串。 */
export function emptyConversation(id) {
  return { id, a: '', b: '' };
}

/** 两句话都空？空对话不进提示词，也不占「已填」计数。 */
export function isBlankConversation(item) {
  return (item?.a ?? '').trim() === '' && (item?.b ?? '').trim() === '';
}

/**
 * 找一个没被占用的 id。
 *
 * @param {Iterable<string>} taken
 * @returns {string}
 */
export function nextId(taken) {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const id = `c-${n}`;
    if (!used.has(id)) return id;
  }
}

/** 一句话的清洗：给值就 trim，不是字符串就报错，超长就报错。 */
function readLine(value, at, label) {
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false, error: `${at}的${label}必须是字符串` };
  const text = value.trim();
  if (text.length > MAX_LINE_CHARS) {
    return { ok: false, error: `${at}的${label}太长了：最多 ${MAX_LINE_CHARS} 字，现在 ${text.length} 字` };
  }
  return { ok: true, value: text };
}

/**
 * 把交上来的对话洗干净。
 *
 * - 必须是数组，条数不设上限；
 * - 每条是对象，`a` / `b` 要么没有、要么是字符串；
 * - 字段 trim、超长报错（不截断，免得悄悄丢使用者的原话）；
 * - id 缺了或重了，重新发一个。
 *
 * @param {unknown} input
 * @returns {{ok: true, conversations: Array<{id: string, a: string, b: string}>} | {ok: false, error: string}}
 */
export function normalizeConversations(input) {
  if (!Array.isArray(input)) return { ok: false, error: 'conversations 必须是数组' };

  const out = [];
  const taken = [];
  for (const [index, raw] of input.entries()) {
    const at = `第 ${index + 1} 条`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `${at}不是对象` };
    }
    const a = readLine(raw.a, at, 'A');
    if (!a.ok) return a;
    const b = readLine(raw.b, at, 'B');
    if (!b.ok) return b;

    const wanted = typeof raw.id === 'string' ? raw.id.trim() : '';
    const id = wanted !== '' && !taken.includes(wanted) ? wanted : nextId(taken);
    taken.push(id);
    out.push({ id, a: a.value, b: b.value });
  }
  return { ok: true, conversations: out };
}

// ---------------------------------------------------------------- 禁令
//
// 禁令回答的是「什么说法一律不要」，分三组：
//   字词     —— 某个词、某个成语、某个口头禅
//   句式     —— 句子长短、断句、总结、防御性回复这类构成
//   语用与语气 —— 说教、讨好、客套这类说话方式
//
// 规矩只有两条：不设条数上限；匹配是「照字面 + 一个通配」——
// `…` 或 `...` 表示中间可以隔几个字，`/` 表示任选其一。

/** 单条禁令的字数上限：够写一句句式，又不至于把一整段塞进来。 */
export const MAX_BAN_CHARS = 120;

/** `不是…而是…` 里那个「…」最多隔多少个字符。 */
export const BAN_GAP_CHARS = 20;

/**
 * 三组禁令。`key` 是存储字段，`label` 是面板上的字。
 *
 * 分组不是为了好看，是为了注进去的时候模型能分清「这是词」「这是句式」「这是态度」—
 * 同一条规则放在不同组里，说给模型的语气不一样。
 */
export const BAN_GROUPS = [
  { key: 'word', label: '字词', hint: '禁止的字词、成语、口头禅' },
  { key: 'pattern', label: '句式', hint: '句子长短、断句、总结、防御性回复这类构成' },
  { key: 'tone', label: '语用与语气', hint: '说教、讨好、客套这类说话方式' },
];

/** 一份空的三组禁令。每次调用都新建，谁改都不串。 */
export function emptyBans() {
  return { word: [], pattern: [], tone: [] };
}

/** 三组是不是全空。全空就不注入、也不拦。 */
export function hasBans(bans) {
  if (!bans || typeof bans !== 'object') return false;
  return BAN_GROUPS.some((group) => Array.isArray(bans[group.key]) && bans[group.key].length > 0);
}

/** 洗一组：去空、去重、限长。条数不设上限。 */
function normalizeGroup(list, label) {
  if (list === undefined || list === null) return { ok: true, list: [] };
  if (!Array.isArray(list)) return { ok: false, error: `${label}必须是数组` };
  const seen = new Set();
  const out = [];
  for (const [index, raw] of list.entries()) {
    if (typeof raw !== 'string') {
      return { ok: false, error: `${label}第 ${index + 1} 条必须是字符串` };
    }
    const text = raw.trim();
    if (text === '') continue;
    if (text.length > MAX_BAN_CHARS) {
      return { ok: false, error: `${label}第 ${index + 1} 条太长了：最多 ${MAX_BAN_CHARS} 字，现在 ${text.length} 字` };
    }
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return { ok: true, list: out };
}

/**
 * 清洗禁令：三组分别洗。
 *
 * 兼容老格式：传一个字符串数组（0.1.x 的 `bans`）就整体当「句式」，
 * 这样旧数据文件不会因为升级丢掉写过的条目。
 *
 * @param {unknown} input
 * @returns {{ok: true, bans: {word: string[], pattern: string[], tone: string[]}} | {ok: false, error: string}}
 */
export function normalizeBans(input) {
  if (Array.isArray(input)) {
    const pattern = normalizeGroup(input, '句式');
    if (!pattern.ok) return pattern;
    return { ok: true, bans: { ...emptyBans(), pattern: pattern.list } };
  }
  if (input === undefined || input === null) return { ok: true, bans: emptyBans() };
  if (typeof input !== 'object') return { ok: false, error: 'bans 必须是对象或数组' };

  const out = emptyBans();
  for (const group of BAN_GROUPS) {
    const normalized = normalizeGroup(input[group.key], group.label);
    if (!normalized.ok) return normalized;
    out[group.key] = normalized.list;
  }
  return { ok: true, bans: out };
}

/** 正则里的特殊字符转义。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 一条禁令 → 若干候选句式。
 *
 * `首先/其次/综上` 拆成三个词，任一出现就算犯；
 * `不是…而是…` 里的 `…` 变成「最多隔 N 个字符」的空隙。
 *
 * @param {string} ban
 * @returns {string[]} 每个元素是一段能直接用的正则源码
 */
export function banPatterns(ban) {
  const phrases = String(ban)
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return phrases.map((phrase) => {
    const pieces = phrase.split(/…|\.\.\./);
    if (pieces.length === 1) return escapeRegExp(phrase);
    return pieces.map(escapeRegExp).join(`[\\s\\S]{0,${BAN_GAP_CHARS}}`);
  });
}

/**
 * 在一段话里找禁令，三组都查。命中就把组名、那条、上下文片段一起交回去，
 * 方便原样说给模型听：「你踩的是语气那条」比「你违规了」有用。
 *
 * @param {string} text 要检查的话（通常是这一轮说出去的内容）
 * @param {{word?: string[], pattern?: string[], tone?: string[]} | string[]} bans
 *   传数组时整体当「句式」（兼容 0.1.x 的数据）
 * @returns {Array<{group: string, label: string, ban: string, phrase: string, snippet: string}>}
 */
export function matchBans(text, bans) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const groups = Array.isArray(bans)
    ? [{ key: 'pattern', label: '句式', items: bans }]
    : BAN_GROUPS.map((group) => ({
      key: group.key,
      label: group.label,
      items: Array.isArray(bans?.[group.key]) ? bans[group.key] : [],
    }));

  const out = [];
  for (const group of groups) {
    for (const ban of group.items) {
      if (typeof ban !== 'string' || ban.trim() === '') continue;
      for (const pattern of banPatterns(ban)) {
        let match;
        try {
          match = new RegExp(pattern, 'i').exec(text);
        } catch {
          continue;
        }
        if (match) {
          const from = Math.max(0, match.index - 10);
          const to = Math.min(text.length, match.index + match[0].length + 10);
          out.push({
            group: group.key,
            label: group.label,
            ban,
            phrase: match[0],
            snippet: text.slice(from, to),
          });
          break;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 结构规则
//
// 「空行」「列表」「加粗」这类词，本来想禁的是**形状**，可字面匹配只会去找这几个字。
// 2026-11-24 他一句话戳破：真打一个空行，"空行"那条根本看不见。
// 所以这三条走另一条路：禁令里提到哪个词，就去正文里查对应的形状。

/**
 * 结构检查：`name` 是禁令里可能出现的词，`test` 是它对应的真实形状。
 *
 * 只做这三样，是因为它们能用正则精确判断；「太长」「太啰嗦」那类靠字面没法查。
 */
export const STRUCTURE_CHECKS = [
  { name: '空行', test: (text) => /\n[ \t]*\n/.test(text) },
  { name: '列表', test: (text) => /(^|\n)[ \t]*([-*+]|\d+\.)[ \t]/.test(text) },
  { name: '加粗', test: (text) => /\*\*[^*\n]+\*\*/.test(text) },
];

/**
 * 在正文里找结构命中。禁令里没提到某个结构词，就不查那个形状。
 *
 * @param {string} text
 * @param {{word?: string[], pattern?: string[], tone?: string[]}} bans
 * @returns {Array<{group: string, label: string, ban: string, phrase: string, snippet: string}>}
 */
export function matchStructure(text, bans) {  if (typeof text !== 'string' || text === '') return [];
  const words = [];
  for (const key of ['word', 'pattern', 'tone']) {
    for (const ban of Array.isArray(bans?.[key]) ? bans[key] : []) {
      if (typeof ban === 'string' && ban.trim() !== '') words.push(ban.trim());
    }
  }
  const out = [];
  for (const check of STRUCTURE_CHECKS) {
    if (!words.some((ban) => ban.includes(check.name))) continue;
    if (!check.test(text)) continue;
    out.push({
      group: 'pattern',
      label: '句式·结构',
      ban: check.name,
      phrase: check.name,
      snippet: `（正文里有${check.name}）`,
    });
  }
  return out;
}
