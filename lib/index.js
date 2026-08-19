/**
 * @dsh-local/session-rotate — 会话自动轮换（省 token）
 *
 * 原理：上下文超阈值 → 向会话注入提醒 → agent 生成交接清单并调用 session_rotate 工具
 *       → 新建会话(继承工作区/agent 预设) + 清单注入为新会话首条消息 + 标题标记
 *       → 延迟归档旧会话（等 agent 总结回复可见）→ 新会话继续累计，循环往复。
 *
 * 检测：apiProxy.events.mux 增量累计 user/assistant 文本字符数；
 *       基线对内存活动会话用 tokenMeter.measure 估算（token×4 启发式）。
 */
export const name = 'session-rotate';
export const inject = ['apiProxy', 'timer'];

export function apply(ctx) {
    const apiProxy = ctx.get('apiProxy');
    if (!apiProxy) return;

    // ---- 配置（阈值可在此调整；2M 字符为用户确认口径）----
    const THRESHOLD_CHARS = 2_000_000;      // 触发轮换的对话文本字符数
    const COOLDOWN_MS = 24 * 3600 * 1000;   // 同一会话提醒冷却（防刷屏）
    const ARCHIVE_DELAY_MS = 60 * 1000;     // 归档延迟：等 agent 总结回复被用户看到
    const BASE_DIR = 'D:\\DeepSeek harness\\handoff';

    // ---- 状态 ----
    const chars = new Map();        // sessionId -> 累计字符数（基线估算 + 增量）
    const remindedAt = new Map();   // sessionId -> 上次提醒时间
    const rotateLog = [];           // {time, old, fresh, title}
    let lastActiveSid = null;       // 最近活跃会话（mux 更新，工具用它定位当前会话）
    const seq = { n: 0 };
    const mint = () => 'sr-' + Date.now().toString(36) + '-' + (seq.n++);

    const log = (...a) => console.log('[session-rotate]', ...a);

    const makeSignal = () => {
        if (typeof AbortController !== 'undefined') {
            const ac = new AbortController();
            return { abort: () => ac.abort(), signal: ac.signal };
        }
        let aborted = false;
        const listeners = [];
        return {
            abort: () => { aborted = true; for (const fn of listeners) fn(); },
            signal: {
                aborted: false,
                addEventListener(type, fn) { listeners.push(fn); },
                removeEventListener() {},
                get aborted() { return aborted; },
            },
        };
    };

    const ts = () => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    };

    // ---- 基线：对内存活动会话用 tokenMeter 估算初始字符数 ----
    const initBaseline = () => {
        const sessions = ctx.get('sessions');
        const tokenMeter = ctx.get('tokenMeter');
        if (!sessions || !tokenMeter) return;
        try {
            let n = 0;
            for (const s of sessions.list()) {
                try {
                    const m = tokenMeter.measure(s);
                    const t = (m && m.totalTokens) || 0;
                    if (t > 0) { chars.set(s.id, Math.round(t * 4)); n++; }
                } catch { /* per-session */ }
            }
            log('基线初始化完成，估算活动会话', n, '个');
        } catch (e) { log('基线初始化失败', String(e)); }
    };
    initBaseline();

    // ---- 消息事件流：累计字符 + 记录活跃会话 + 阈值检查 ----
    ctx.effect(() => {
        const ctrl = makeSignal();
        const run = async () => {
            try {
                const stream = apiProxy.events.mux({ rpcId: mint(), payload: {} }, ctrl.signal);
                for await (const frame of stream) {
                    const f = frame.payload || {};
                    const sid = f.sessionId;
                    if (!sid) continue;
                    if (f.type === 'session/event') {
                        const ev = f.event || {};
                        if (ev.type === 'user/message' || ev.type === 'assistant/message') {
                            lastActiveSid = sid;
                            const content = ev.type === 'user/message'
                                ? (ev.data && ev.data.content) || []
                                : (ev.data && ev.data.message && ev.data.message.content) || [];
                            const len = content.reduce((n, b) => n + (b && b.type === 'text' ? (b.text || '').length : 0), 0);
                            if (len > 0) {
                                chars.set(sid, (chars.get(sid) || 0) + len);
                                checkRotate(sid);
                            }
                        }
                    }
                }
            } catch (e) { log('mux 流错误', String(e)); }
        };
        run();
        return () => ctrl.abort();
    });

    // ---- 阈值检查 + 注入提醒 ----
    const checkRotate = (sid) => {
        const cur = chars.get(sid) || 0;
        if (cur < THRESHOLD_CHARS) return;
        const last = remindedAt.get(sid) || 0;
        if (Date.now() - last < COOLDOWN_MS) return;
        remindedAt.set(sid, Date.now());
        const text = '【自动轮换提醒】本会话上下文已达约 ' + (cur / 10000).toFixed(1) + ' 万字符（阈值 ' + (THRESHOLD_CHARS / 10000) + ' 万）。为节省 token，请立即执行：\n'
            + '1. 用 write 工具将交接清单写入 ' + BASE_DIR + '\\rotate-' + ts() + '.md（精炼要点：项目目标/当前进度/关键决策/未完成事项/下一步，勿写大段日志）；\n'
            + '2. 调用 session_rotate 工具，参数 { handoffPath: 清单绝对路径, newTitle: 可选新标题 }；\n'
            + '3. 轮换后本会话约 1 分钟后自动归档，请在新会话继续工作。若你无法完成，请回复用户说明并给出指引。';
        apiProxy.sessions.prompt({ rpcId: mint(), payload: { sessionId: sid, mode: 'queue', content: [{ type: 'text', text }] } })
            .catch((e) => log('提醒注入失败', sid, String(e)));
        log('阈值触发', sid, cur);
    };

    // ---- 会话审计：统计 token 消耗构成，输出 TOP 3 原因 ----
    const SYS_PREFIXES = [
        'Current runtime context', '[MNEMON]', 'Contents of USER.md', 'memory_system',
        '【自动轮换提醒】', '[铭文', 'MNEMON RUNTIME MEMORY PROTOCOL', 'IMPORTANT: USER.md',
        '[memory_system]', 'current runtime context',
    ];
    const isSysInjected = (t) => SYS_PREFIXES.some((p) => t.startsWith(p));

    const blocksOf = (ev) => {
        const data = ev.data || {};
        if (ev.type === 'user/message') return Array.isArray(data.content) ? data.content : [];
        const msg = data.message || {};
        // assistant/message 与 tool/result 的文本都在 data.message.content 块中
        if (ev.type === 'assistant/message' || ev.type === 'tool/result') return Array.isArray(msg.content) ? msg.content : [];
        if (Array.isArray(data.content)) return data.content;
        return [];
    };
    const blockChars = (b) => {
        if (!b || typeof b !== 'object') return 0;
        if (b.type === 'text') return (b.text || '').length;
        if (b.type === 'reasoning') return (b.text || '').length;
        if (b.type === 'tool-call') return (b.arguments || '').length;
        if (b.type === 'tool-result') {
            if (typeof b.content === 'string') return b.content.length;
            if (Array.isArray(b.content)) return b.content.reduce((s, x) => s + (x && typeof x.text === 'string' ? x.text.length : 0), 0);
            return 0;
        }
        return 0;
    };

    // 返回 { stats, cats }；cats = 按消耗降序的前 3 大原因
    const analyzeSession = async (sid) => {
        const stats = { userText: 0, injected: 0, assistantText: 0, reasoning: 0, toolArgs: 0, toolResult: 0, toolCalls: 0, rounds: 0, totalTokens: 0 };
        try {
            const sq = ctx.get('sessionQuery');
            if (!sq || !sq.readSession) return { stats, cats: [] };
            const loaded = await sq.readSession(sid);
            if (!loaded || !Array.isArray(loaded.events)) return { stats, cats: [] };
            for (const ev of loaded.events) {
                const blocks = blocksOf(ev);
                for (const b of blocks) {
                    if (!b || typeof b !== 'object') continue;
                    const n = blockChars(b);
                    if (b.type === 'text') {
                        const t = (b.text || '').trim();
                        if (ev.type === 'user/message') {
                            if (isSysInjected(t)) stats.injected += n;
                            else { stats.userText += n; if (t) stats.rounds++; }
                        } else stats.assistantText += n;
                    } else if (b.type === 'reasoning') stats.reasoning += n;
                    else if (b.type === 'tool-call') { stats.toolCalls++; stats.toolArgs += n; }
                    else if (b.type === 'tool-result') stats.toolResult += n;
                }
            }
        } catch (e) { log('审计读取失败', String(e)); }
        try {
            const tm = ctx.get('tokenMeter');
            const sess = ctx.get('sessions') && ctx.get('sessions').get(sid);
            if (tm && sess) { const m = tm.measure(sess); stats.totalTokens = (m && m.totalTokens) || 0; }
        } catch { /* ignore */ }
        const cats = [
            { name: '工具调用与结果', chars: stats.toolResult + stats.toolArgs, note: stats.toolCalls + ' 次工具调用' },
            { name: '思考链 reasoning', chars: stats.reasoning, note: '推理过程（已用 medium 档优化）' },
            { name: '记忆/系统上下文注入', chars: stats.injected, note: 'MNEMON/运行时上下文等自动注入' },
            { name: '助手回复正文', chars: stats.assistantText, note: '可见输出' },
            { name: '用户输入', chars: stats.userText, note: stats.rounds + ' 轮消息' },
        ].filter((c) => c.chars > 0).sort((a, b) => b.chars - a.chars).slice(0, 3);
        return { stats, cats };
    };

    const formatAudit = (sid, res) => {
        const { stats, cats } = res;
        const tok = (c) => Math.max(1, Math.round(c / 2)); // 中文为主，1 字符 ≈ 0.5~1 token 保守估算
        const lines = ['📊 会话 Token 审计（' + String(sid).slice(0, 20) + '）'];
        lines.push('总轮次 ' + stats.rounds + ' | 工具调用 ' + stats.toolCalls + ' 次');
        if (stats.totalTokens > 0) {
            lines.push('⚠️ 上下文重发成本：约 ' + stats.rounds + ' 轮 × 当前上下文 ≈ ' + Math.round((stats.totalTokens * Math.max(1, stats.rounds)) / 10000) + ' 万 token 累计 —— 每轮请求都重发历史，这是最大开销，轮换后清零');
        }
        if (!cats.length) {
            lines.push('（无消息数据）');
            return lines.join('\n');
        }
        cats.forEach((c, i) => {
            lines.push('TOP ' + (i + 1) + '：' + c.name + ' —— ' + (c.chars / 10000).toFixed(1) + ' 万字符（≈' + tok(c.chars) + ' token）｜' + c.note);
        });
        return lines.join('\n');
    };

    // ---- session_rotate 工具 ----
    const tools = ctx.get('tools');
    if (tools) {
        tools.register({
            name: 'session_rotate',
            description: '自动轮换当前会话：读取交接清单→创建新会话（继承工作区/agent预设）→把清单注入为新会话首条消息→标题标记→约1分钟后归档本会话。用于上下文过大时省token。调用前必须先用 write 工具写好转交清单文件。',
            parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['handoffPath'],
                properties: {
                    handoffPath: { type: 'string', description: '交接清单文件绝对路径（须已由 write 工具写入，如 D:\\DeepSeek harness\\handoff\\rotate-20260819-1230.md）' },
                    newTitle: { type: 'string', description: '新会话标题（可选，默认"🔄 轮换自<旧会话标题>"）' },
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['newSessionId', 'oldSessionId', 'message'],
                    properties: {
                        newSessionId: { type: 'string' },
                        oldSessionId: { type: 'string' },
                        newTitle: { type: 'string' },
                        message: { type: 'string' },
                    },
                },
                render: (_args, value) => [{ type: 'text', text: value.message || JSON.stringify(value) }],
            },
            async execute(args) {
                const oldSid = lastActiveSid;
                if (!oldSid) return { newSessionId: '', oldSessionId: '', message: '无法确定当前会话，轮换中止，请重试。' };

                // 1. 读清单
                let handoffText = '';
                try {
                    const fs = ctx.get('fs');
                    if (fs) handoffText = await fs.readText(await fs.resolve(args.handoffPath));
                } catch (e) { log('清单读取失败', String(e)); }

                // 1b. 会话审计（2M 对话结束：TOP 3 token 消耗原因）
                let auditText = '';
                let auditStats = null;
                try {
                    const res = await analyzeSession(oldSid);
                    auditStats = res.stats;
                    auditText = formatAudit(oldSid, res);
                    const auditFile = BASE_DIR + '\\audit-' + ts() + '.md';
                    try {
                        const fs = ctx.get('fs');
                        if (fs) await fs.writeText(await fs.resolve(auditFile), auditText + '\n');
                    } catch (e) { log('审计文件写入失败', String(e)); }
                } catch (e) { log('审计失败', String(e)); }

                // 2. 旧会话标题
                let oldTitle = '';
                try {
                    const resp = await apiProxy.sessions.list({ rpcId: mint(), payload: {} });
                    const items = resp && resp.result && resp.result.ok ? resp.result.value.items : [];
                    const it = (items || []).find((i) => (i.sessionId || i.id) === oldSid);
                    if (it) oldTitle = it.title || '';
                } catch { /* ignore */ }

                // 3. 创建新会话（继承 cwd + agentPreset）
                const sessions = ctx.get('sessions');
                if (!sessions) return { newSessionId: '', oldSessionId: oldSid, message: 'sessions 服务不可用，轮换中止。' };
                try {
                    const meta = {};
                    try {
                        const oldS = sessions.get(oldSid);
                        if (oldS && oldS.header) {
                            if (oldS.header.cwd) meta.cwd = oldS.header.cwd;
                            if (oldS.header.agentPreset) meta.agentPreset = oldS.header.agentPreset;
                        }
                    } catch { /* ignore */ }
                    if (!meta.agentPreset) {
                        try {
                            const ap = ctx.get('agentPresets');
                            if (ap) { const preset = await ap.resolve(); if (preset && preset.id) meta.agentPreset = preset.id; }
                        } catch { /* ignore */ }
                    }
                    const newSession = sessions.create(undefined, { meta });
                    const newId = newSession.id;

                    // 4. 清单注入为新会话首条消息
                    const intro = '【自动轮换】本会话由旧会话轮换而来（旧会话 ' + (oldTitle || oldSid) + ' 已归档）。交接清单如下，请据此无缝继续：\n\n'
                        + (handoffText || '(清单为空，见文件 ' + args.handoffPath + ')').slice(0, 30000)
                        + (handoffText.length > 30000 ? '\n\n…（清单过长已截断，完整内容见 ' + args.handoffPath + '）' : '');
                    try {
                        await apiProxy.sessions.prompt({ rpcId: mint(), payload: { sessionId: newId, mode: 'queue', content: [{ type: 'text', text: intro }] } });
                    } catch (e) { log('清单注入新会话失败（清单已落盘，不阻塞）', String(e)); }

                    // 5. 标题
                    const finalTitle = args.newTitle || ('🔄 ' + (oldTitle || '轮换会话'));
                    try {
                        const st = ctx.get('sessionTitle');
                        if (st && st.rename) st.rename(newSession, finalTitle);
                    } catch { /* ignore */ }

                    // 6. 延迟归档旧会话（等 agent 总结回复可见）
                    try {
                        const timer = ctx.get('timer');
                        if (timer && timer.timeout) {
                            timer.timeout(() => {
                                const wr = ctx.get('workspaceRegistry');
                                if (wr && wr.archiveSession) {
                                    wr.archiveSession(oldSid).then(() => log('旧会话已归档', oldSid)).catch((e) => log('归档失败', String(e)));
                                }
                            }, ARCHIVE_DELAY_MS);
                        }
                    } catch { /* ignore */ }

                    rotateLog.unshift({ time: Date.now(), old: oldSid, fresh: newId, title: finalTitle, audit: auditStats });
                    log('轮换完成', oldSid, '->', newId);
                    return {
                        newSessionId: newId,
                        oldSessionId: oldSid,
                        newTitle: finalTitle,
                        message: '轮换成功！新会话：' + newId + '（标题：' + finalTitle + '）。交接清单已注入为新会话首条消息，旧会话约 1 分钟后归档。\n\n'
                            + (auditText ? auditText + '\n\n' : '')
                            + '请告知用户到新会话继续，并把上述审计结论（TOP token 消耗原因）呈现给用户。',
                    };
                } catch (e) {
                    log('轮换执行失败', String(e));
                    return { newSessionId: '', oldSessionId: oldSid, message: '轮换失败：' + String(e) };
                }
            },
        });
        log('session_rotate 工具已注册');
    }

    // ---- status 端点（调试/手机壳查看）----
    const webServer = ctx.get('webServer');
    if (webServer) {
        ctx.effect(() => webServer.register({
            kind: 'prefix',
            path: '/session-rotate/status',
            handler: async (req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    thresholdChars: THRESHOLD_CHARS,
                    sessions: Array.from(chars.entries()).map(([id, c]) => ({ sessionId: id, chars: c, over: c >= THRESHOLD_CHARS })),
                    lastActive: lastActiveSid,
                    rotateLog: rotateLog.slice(0, 20),
                }));
            },
        }));
        log('status 端点已注册');
    }
}
