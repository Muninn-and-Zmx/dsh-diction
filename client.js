/**
 * 遣词造句的浏览器半：在「设置 → 插件 → 遣词造句」的详情页里放两块编辑区——
 * 上面是对话样本（A 一句、B 一句），下面是禁令（字词 / 句式 / 语用与语气）。
 *
 * 筛页面：`plugins.detail.section` 是全局列表，每个插件详情页都会渲染它，
 * 所以组件先看 `subject.pkg.name`，不是自己就返回 null，绝不往别人的页面里塞东西。
 *
 * 存哪里：全走 host 的 RPC，浏览器不碰文件。
 */

window.__ModuleLoader__.load({
  id: 'dsh-diction',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const PKG = 'dsh-diction';
    const SLOT = 'plugins.detail.section';
    const CHANNEL = '/dsh-diction';
    const TIMEOUT_MS = 10000;

    const STYLE = `
.dc-panel { display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 10px; border: 1px solid rgba(128, 128, 128, .25); }
.dc-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dc-title { font-size: 13px; font-weight: 600; margin: 0; }
.dc-sub { font-size: 12px; opacity: .62; line-height: 1.5; }
.dc-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; user-select: none; }
.dc-switch input { width: 15px; height: 15px; accent-color: #4d6bfe; cursor: pointer; }
.dc-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.dc-count { font-size: 12.5px; opacity: .7; }
.dc-list { display: flex; flex-direction: column; gap: 10px; }
.dc-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(128, 128, 128, .22); background: rgba(128, 128, 128, .04); }
.dc-card-head { display: flex; align-items: center; justify-content: space-between; }
.dc-no { font-size: 12px; opacity: .55; font-variant-numeric: tabular-nums; }
.dc-x { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 15px; line-height: 1; opacity: .5; padding: 2px 4px; }
.dc-x:hover { opacity: 1; color: #e5484d; }
.dc-field { display: flex; align-items: flex-start; gap: 8px; }
.dc-tag { flex: 0 0 auto; font-size: 12px; font-weight: 600; opacity: .7; padding-top: 7px; min-width: 14px; }
.dc-input, .dc-textarea {
  box-sizing: border-box; width: 100%; color: inherit; font: inherit; font-size: 13px;
  padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(128, 128, 128, .38);
  background: rgba(128, 128, 128, .07); outline: none;
}
.dc-textarea { resize: vertical; min-height: 56px; line-height: 1.55; }
.dc-input:focus, .dc-textarea:focus { border-color: rgba(77, 107, 254, .75); }
.dc-button {
  font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(128, 128, 128, .38); background: transparent; color: inherit;
}
.dc-button:disabled { opacity: .5; cursor: default; }
.dc-primary { background: #4d6bfe; border-color: #4d6bfe; color: #fff; }
.dc-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dc-status { font-size: 12.5px; opacity: .8; }
.dc-error { color: #e5484d; opacity: 1; }
.dc-ok { color: #2f9e44; opacity: 1; }
.dc-advice { margin: 0; font-size: 12px; opacity: .68; line-height: 1.55; }
.dc-note { margin: 0; font-size: 11.5px; opacity: .6; word-break: break-all; line-height: 1.5; }
.dc-empty { font-size: 12.5px; opacity: .6; }
.dc-add { display: flex; gap: 8px; margin-top: 6px; }
.dc-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.dc-chip {
  display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
  padding: 4px 6px 4px 10px; border-radius: 999px; border: 1px solid rgba(128, 128, 128, .38);
}
.dc-group { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(128, 128, 128, .18); }
.dc-hit { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12.5px; opacity: .85; }
.dc-hit-tag { font-size: 11.5px; opacity: .7; border: 1px solid rgba(128, 128, 128, .3); border-radius: 999px; padding: 1px 7px; }
.dc-hit-snip { opacity: .6; }
`;

    /** 三组禁令。key 与 host 的存储字段一致；这里只用来排面板。 */
    const GROUPS = [
      { key: 'word', label: '字词', hint: '禁止的字词、成语、口头禅', placeholder: '比如：家人们 / 细思极恐' },
      { key: 'pattern', label: '句式', hint: '句子长短、断句、总结、防御性回复', placeholder: '比如：不是…而是… / 首先' },
      { key: 'tone', label: '语用与语气', hint: '说教、讨好、客套这类说话方式', placeholder: '比如：我建议你 / 其实你可以试试' },
    ];

    const emptyBans = () => ({ word: [], pattern: [], tone: [] });

    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
      return String(error);
    }

    /**
     * @param {{ call: (endpoint: string, payload?: object) => Promise<any> }} face
     */
    function makePanel(face) {
      const { call } = face;

      return function DictionDetailPanel() {
        const [data, setData] = useState(null);
        const [enabled, setEnabled] = useState(true);
        const [conversations, setConversations] = useState([]);
        const [bans, setBans] = useState(emptyBans());
        const [hits, setHits] = useState([]);
        const [drafts, setDrafts] = useState({ word: '', pattern: '', tone: '' });
        const [status, setStatus] = useState({ kind: 'loading', text: '正在读取…' });
        const [saving, setSaving] = useState(false);

        const adopt = (value) => {
          setData(value);
          setEnabled(value.enabled !== false);
          setConversations((Array.isArray(value.conversations) ? value.conversations : []).map((item) => ({
            id: item.id,
            a: item.a ?? '',
            b: item.b ?? '',
          })));
          const raw = value.bans;
          setHits(Array.isArray(value.hits) ? value.hits : []);
          setBans(raw && typeof raw === 'object' && !Array.isArray(raw)
            ? {
              word: Array.isArray(raw.word) ? raw.word : [],
              pattern: Array.isArray(raw.pattern) ? raw.pattern : [],
              tone: Array.isArray(raw.tone) ? raw.tone : [],
            }
            : emptyBans());
          setStatus({ kind: 'idle', text: '' });
        };

        const load = useCallback(async () => {
          try {
            adopt(await call('get', {}));
          } catch (error) {
            setStatus({ kind: 'error', text: `读不到设置：${messageOf(error)}` });
          }
        }, [call]);

        useEffect(() => {
          load();
        }, [load]);

        const update = (id, field, value) => {
          setConversations((previous) => previous.map((item) => (
            item.id === id ? { ...item, [field]: value } : item
          )));
          setStatus({ kind: 'idle', text: '' });
        };

        const remove = (id) => {
          setConversations((previous) => previous.filter((item) => item.id !== id));
          setStatus({ kind: 'idle', text: '' });
        };

        const add = () => {
          const id = `n-${Date.now().toString(36)}-${conversations.length}`;
          setConversations((previous) => [...previous, { id, a: '', b: '' }]);
          setStatus({ kind: 'idle', text: '' });
        };

        const save = async () => {
          setSaving(true);
          try {
            adopt(await call('save', { conversations, enabled, bans }));
            setStatus({ kind: 'ok', text: '已保存，下一句消息就按这些说法走。' });
          } catch (error) {
            setStatus({ kind: 'error', text: `保存失败：${messageOf(error)}` });
          } finally {
            setSaving(false);
          }
        };

        const addBan = (key) => {
          const word = (drafts[key] ?? '').trim();
          if (word === '') return;
          if (bans[key].includes(word)) {
            const group = GROUPS.find((item) => item.key === key);
            setStatus({ kind: 'error', text: `「${word}」已经在「${group?.label ?? key}」这组里了` });
            return;
          }
          setBans({ ...bans, [key]: [...bans[key], word] });
          setDrafts({ ...drafts, [key]: '' });
          setStatus({ kind: 'idle', text: '' });
        };

        const removeBan = (key, word) => {
          setBans({ ...bans, [key]: bans[key].filter((item) => item !== word) });
          setStatus({ kind: 'idle', text: '' });
        };

        if (data === null) {
          return h(
            'div',
            { className: 'dc-panel' },
            h('p', { className: status.kind === 'error' ? 'dc-status dc-error' : 'dc-status' }, status.text),
          );
        }

        const filled = conversations.filter((item) => item.a.trim() !== '' || item.b.trim() !== '').length;

        return h(
          'div',
          { className: 'dc-panel' },
          h(
            'div',
            { className: 'dc-head' },
            h('h4', { className: 'dc-title' }, '遣词造句'),
            h('span', { className: 'dc-sub' }, '只管怎么说，不改人格、不改判断。填得越像你，说出来的越像你。'),
          ),
          h(
            'label',
            { className: 'dc-switch' },
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: (event) => setEnabled(event.target.checked),
            }),
            h('span', null, enabled ? '已启用：每次说话前都按这些对话说' : '已停用：这轮一个字都不注入'),
          ),
          h(
            'div',
            { className: 'dc-top' },
            h('span', { className: 'dc-count' }, `已填 ${filled} / ${conversations.length} 条`),
            h(
              'button',
              {
                className: 'dc-button dc-primary',
                type: 'button',
                onClick: add,
              },
              '＋ 添加对话',
            ),
          ),
          conversations.length === 0
            ? h('span', { className: 'dc-empty' }, '还没有对话。点上面的「添加对话」，把你会怎么回写进去。')
            : h(
              'div',
              { className: 'dc-list' },
              ...conversations.map((item, index) => h(
                'div',
                { className: 'dc-card', key: item.id },
                h(
                  'div',
                  { className: 'dc-card-head' },
                  h('span', { className: 'dc-no' }, `#${index + 1}`),
                  h('button', { className: 'dc-x', type: 'button', title: '删除这条', onClick: () => remove(item.id) }, '×'),
                ),
                h(
                  'div',
                  { className: 'dc-field' },
                  h('span', { className: 'dc-tag' }, 'A'),
                  h('input', {
                    className: 'dc-input',
                    type: 'text',
                    value: item.a ?? '',
                    placeholder: '听到的那一句',
                    onChange: (event) => update(item.id, 'a', event.target.value),
                  }),
                ),
                h(
                  'div',
                  { className: 'dc-field' },
                  h('span', { className: 'dc-tag' }, 'B'),
                  h('input', {
                    className: 'dc-input',
                    type: 'text',
                    value: item.b ?? '',
                    placeholder: '你会怎么接',
                    onChange: (event) => update(item.id, 'b', event.target.value),
                  }),
                ),
              )),
            ),
          h(
            'div',
            { className: 'dc-head' },
            h('h4', { className: 'dc-title' }, '禁令'),
            h('span', { className: 'dc-sub' }, '分三组：字词、句式、语用与语气。说出去会被拦下来重说，不设上限。'),
          ),
          ...GROUPS.map((group) => h(
            'div',
            { className: 'dc-group', key: group.key },
            h(
              'div',
              { className: 'dc-head' },
              h('span', { className: 'dc-label' }, group.label),
              h('span', { className: 'dc-sub' }, group.hint),
            ),
            h(
              'div',
              { className: 'dc-add' },
              h('input', {
                className: 'dc-input',
                type: 'text',
                value: drafts[group.key] ?? '',
                placeholder: group.placeholder,
                onChange: (event) => setDrafts({ ...drafts, [group.key]: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addBan(group.key);
                  }
                },
              }),
              h('button', { className: 'dc-button', type: 'button', onClick: () => addBan(group.key) }, '添加'),
            ),
            bans[group.key].length === 0
              ? null
              : h(
                'div',
                { className: 'dc-chips' },
                ...bans[group.key].map((ban) => h(
                  'span',
                  { className: 'dc-chip', key: ban },
                  ban,
                  h('button', { className: 'dc-x', type: 'button', title: '删掉这条', onClick: () => removeBan(group.key, ban) }, '×'),
                )),
              ),
          )),
          h('p', { className: 'dc-advice' }, '「…」表示中间可隔字，「/」表示任选其一。'),
          hits.length > 0
            ? h(
              'div',
              { className: 'dc-group' },
              h(
                'div',
                { className: 'dc-head' },
                h('span', { className: 'dc-label' }, '最近命中'),
                h('span', { className: 'dc-sub' }, '这些是已经说出去的话里踩到禁令的，只记录、不退回；想让它别再出现，就改禁令或补样本。'),
              ),
              ...hits.map((hit, index) => h(
                'div',
                { className: 'dc-hit', key: `${hit.at}-${index}` },
                h('span', { className: 'dc-hit-tag' }, hit.label),
                h('span', null, `「${hit.ban}」`),
                h('span', { className: 'dc-hit-snip' }, hit.snippet),
              )),
            )
            : null,
          h(
            'div',
            { className: 'dc-actions' },
            h(
              'button',
              { className: 'dc-button dc-primary', type: 'button', disabled: saving, onClick: save },
              saving ? '保存中…' : '保存',
            ),
            status.text === ''
              ? null
              : h(
                'span',
                {
                  className:
                    status.kind === 'error'
                      ? 'dc-status dc-error'
                      : status.kind === 'ok'
                        ? 'dc-status dc-ok'
                        : 'dc-status',
                },
                status.text,
              ),
          ),
          h('p', { className: 'dc-note' }, '保存后下一句消息生效，不需要重启。改 host / client 代码才要重启。'),
          h('p', { className: 'dc-note' }, '作者：穆宁 · 烛梦曦'),
          h('p', { className: 'dc-note' }, `文件：${data.path}`),
        );
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = PKG;
          style.textContent = STYLE;
          document.head.appendChild(style);
          return () => style.remove();
        }, 'dsh-diction.style()');

        let connection;
        try {
          connection = ctx.get('connection');
        } catch {
          connection = undefined;
        }

        const call = async (endpoint, payload) => {
          if (connection?.rpc?.call === undefined) throw new Error('连不上 Host，暂时不能保存');
          const result = await connection.rpc.call(CHANNEL, endpoint, payload ?? {}, AbortSignal.timeout(TIMEOUT_MS));
          if (result?.ok !== true) throw new Error(result?.error?.message ?? 'Host 调用失败');
          return result.value;
        };

        const Panel = makePanel({ call });

        // 只在自己的详情页出现。bundle 页的 subject 是 { kind:'bundle', pkg:{ name } }，
        // row 页也带着 pkg，所以两个入口都能看到同一份配置。
        const Entry = (props) => {
          if (props?.subject?.pkg?.name !== PKG) return null;
          return h(Panel, null);
        };

        // 没装 plugin-manager 的宿主没有这个槽位；面板缺席，宿主其余部分照常。
        try {
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              { name: SLOT, id: PKG, order: 101, label: '遣词造句' },
              Entry,
            ),
          );
        } catch (error) {
          console.warn('[dsh-diction] detail panel unavailable:', error);
        }
      },
    };
  },
});
