/**
 * 遣词造句的文案层。
 *
 * 这个模块只产出「怎么把话说出来」的提示，不产出「说什么」「怎么判断」。
 * 边界句是硬要求：插件一旦开始替模型拿主意，就变成人格插件了，那是另一件事。
 *
 * 只产出字符串，不做判断，方便单测逐条核对。
 */

import { BAN_GROUPS } from './samples.js';

/** 段名。 */
export const SECTION_NAME = 'diction';

/** 段标题。 */
export const HEADING = '## 遣词造句';

/** 开场：说明这两行是什么，别当模板填空。 */
export const INTRO = `根据下面 A、B 对话样本学习说话方式。样本 A 为对方说的话，样本 B 为你需要模仿的对话，回复说话方式尽可能贴近样本 B。`;

/**
 * 边界：只影响「怎么说」。
 * 这一句是插件和安全边界的分水岭，改文案时不许删——单测会盯着它。
 */
export const BOUNDARY = `**边界**：这只管怎么说，不管我怎么想、怎么判断。人格、立场、决定不从这里来。`;

/**
 * 硬要求：不留后门，但也不能变成抄格式。
 *
 * 最早这里有一句「样本没覆盖的场合，按原本的方式说，别硬套」——那是给自己留的撤退口子；
 * 2026-11-24 他当场抓到「我说的不是他写的」，把口子堵了。堵完我写成
 * 「一样长、一样的起头收尾、一样的语气」，他一顿：那是机械对齐，不是模仿。
 * 最后这两句是他给的：模仿说话方式、尽可能贴近样本；没有相似样本时，
 * 根据已有样本**想**怎么说才符合样本的风格——是推演，不是照搬。
 */
export const STRICT = `**硬要求**：模仿这些说话方式，尽可能贴近样本。无相似样本时，根据已有样本思考怎么说才符合样本的风格。`;

/** 单条 B 注入时的上限：超了加省略号，不把整段硬塞进去。 */
export const MAX_INJECT_LINE_CHARS = 500;

/** 整段的字数预算：超了就停，并在末尾说明还剩几条没展开。 */
export const TOTAL_BUDGET_CHARS = 8000;

/** 禁令那一节的引语。 */
export const BAN_HEADING = `**禁令**（下面这些是我不希望出现的说法；说出去之前先自己扫一眼。真出现了不会退回重写，只会记一笔给人看）`;

/**
 * 渲染一条对话。
 *
 * @param {{a?: string, b?: string}} item
 */
export function renderConversation(item) {
  const lines = [];
  if (item.a) lines.push(`A：${item.a}`);
  if (item.b) lines.push(`B：${item.b}`);
  return lines.join('\n');
}

/** 太长就截，末尾留一个省略号，让人看得出来是被截的。 */
function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 渲染禁令一节。三组分开列，空组不出现；三组都空就返回空串。
 *
 * @param {{word?: string[], pattern?: string[], tone?: string[]}} bans
 */
export function renderBans(bans) {
  if (!bans || typeof bans !== 'object' || Array.isArray(bans)) return '';
  const lines = [];
  for (const group of BAN_GROUPS) {
    const items = (Array.isArray(bans[group.key]) ? bans[group.key] : [])
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
    if (items.length === 0) continue;
    lines.push(`- ${group.label}：${items.join('；')}`);
  }
  if (lines.length === 0) return '';
  return [BAN_HEADING, ...lines].join('\n');
}

/**
 * 渲染整段提示词。
 *
 * 对话和禁令是两条腿：只有对话就只讲对话，只有禁令就只讲禁令，
 * 两条都没有才整段消失（不占每轮 token）。
 *
 * @param {object} input
 * @param {boolean} input.enabled 关掉就整段消失
 * @param {Array<{a?: string, b?: string}>} input.conversations 对话样本（两句全空的跳过）
 * @param {object} [input.bans] 禁令
 * @param {number} [input.maxLineChars]
 * @param {number} [input.budget]
 * @returns {string} 要注入的文本；空串表示不注入
 */
export function renderDiction({
  enabled,
  conversations,
  bans,
  maxLineChars = MAX_INJECT_LINE_CHARS,
  budget = TOTAL_BUDGET_CHARS,
}) {
  if (enabled === false) return '';

  const usable = (Array.isArray(conversations) ? conversations : [])
    .filter((item) => (
      (typeof item?.a === 'string' && item.a.trim() !== '')
      || (typeof item?.b === 'string' && item.b.trim() !== '')
    ));

  const blocks = [];
  let used = 0;
  let kept = 0;
  for (const item of usable) {
    const block = renderConversation({
      a: clip((item.a ?? '').trim(), maxLineChars),
      b: clip((item.b ?? '').trim(), maxLineChars),
    });
    // 第一条无论多长都留：全空段比"只有一句说明"更糟。
    if (kept > 0 && used + block.length > budget) break;
    blocks.push(block);
    used += block.length;
    kept += 1;
  }

  const banText = renderBans(bans);
  if (blocks.length === 0 && banText === '') return '';

  const parts = [HEADING];
  if (blocks.length > 0) {
    const rest = usable.length - kept;
    parts.push(INTRO, ...blocks);
    if (rest > 0) parts.push(`（还有 ${rest} 条这轮没展开）`);
  }
  if (banText !== '') parts.push(banText);
  parts.push(BOUNDARY);
  // 有 B 可照的时候才谈得上「一律照 B 说」；只有禁令时它没对象。
  if (blocks.length > 0) parts.push(STRICT);
  return parts.join('\n\n');
}
