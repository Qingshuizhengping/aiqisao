// 流式问答接口（SSE）—— 前端主路径
import { API_BASE, MODEL, MAX_TOKENS, TEMPERATURE, buildMessages, textToHtml, getApiKey } from './_config.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'error', error: 'Method not allowed' });
    }

    const apiKey = getApiKey();
    if (!apiKey) {
        return res.status(500).json({ status: 'error', error: '服务端未配置 SILICONFLOW_API_KEY 环境变量' });
    }

    const { question, history } = req.body || {};
    if (!question || !String(question).trim()) {
        return res.status(400).json({ status: 'error', error: 'question 不能为空' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const write = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

    try {
        const resp = await fetch(API_BASE + '/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey
            },
            body: JSON.stringify({
                model: MODEL,
                messages: buildMessages(question, history),
                stream: true,
                max_tokens: MAX_TOKENS,
                temperature: TEMPERATURE
            })
        });

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            write({ type: 'error', error: 'AI服务返回 HTTP ' + resp.status + '：' + errText.slice(0, 200) });
            return res.end();
        }

        write({ type: 'start' });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let full = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                let data;
                try { data = JSON.parse(payload); } catch (e) { continue; }
                const token = data && data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
                if (token) {
                    full += token;
                    write({ type: 'token', content: token });
                }
            }
        }

        write({ type: 'done', html: textToHtml(full) });
        return res.end();
    } catch (e) {
        write({ type: 'error', error: (e && e.message) || '内部错误' });
        return res.end();
    }
}
