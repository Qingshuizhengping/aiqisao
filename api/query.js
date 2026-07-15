// 非流式问答接口（降级路径）
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
                stream: false,
                max_tokens: MAX_TOKENS,
                temperature: TEMPERATURE
            })
        });

        if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return res.status(502).json({ status: 'error', error: 'AI服务返回 HTTP ' + resp.status + '：' + errText.slice(0, 200) });
        }

        const data = await resp.json();
        const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        return res.status(200).json({ status: 'ok', html: textToHtml(content) });
    } catch (e) {
        return res.status(500).json({ status: 'error', error: (e && e.message) || '内部错误' });
    }
}
