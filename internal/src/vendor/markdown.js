import { Marked } from './marked-18.0.9.mjs';

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
}

function safeHref(value) {
    const href = String(value || '').trim();
    if (!/^(?:https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020\u007f-\u009f]/.test(href)) return null;
    try {
        const parsed = new URL(href);
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
        return href;
    } catch {
        return null;
    }
}

const markdown = new Marked({
    async: false,
    gfm: true,
    breaks: true,
    renderer: {
        html({ text }) {
            return escapeHtml(text);
        },
        link({ href, title, tokens }) {
            const label = this.parser.parseInline(tokens);
            const destination = safeHref(href);
            if (!destination) return label;
            const titleAttribute = title ? ' title="' + escapeHtml(title) + '"' : '';
            return '<a href="' + escapeHtml(destination) + '"' + titleAttribute + ' target="_blank" rel="noopener noreferrer">' + label + '</a>';
        },
        image({ text }) {
            return escapeHtml(text || '图片');
        },
        code({ text, lang }) {
            const language = String(lang || '').split(/\s/, 1)[0];
            const languageAttribute = /^[a-z0-9_-]+$/i.test(language) ? ' class="language-' + language + '"' : '';
            return '<pre><code' + languageAttribute + '>' + escapeHtml(text) + '</code></pre>\n';
        }
    },
    extensions: [{
        name: 'qisaoLooseStrong',
        level: 'inline',
        start(source) {
            return source.indexOf('**');
        },
        tokenizer(source) {
            const match = /^\*\*(?![\s*])([^\n*`\\]{1,500}?)[ \t]+\*\*(?!\*)/.exec(source);
            if (!match || !/[\u3400-\u9fff]/.test(match[1])) return;
            return { type: 'qisaoLooseStrong', raw: match[0], tokens: this.lexer.inlineTokens(match[1]) };
        },
        renderer(token) {
            return '<strong>' + this.parser.parseInline(token.tokens) + '</strong>';
        }
    }]
});

export function renderMarkdown(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n');
    try {
        return markdown.parse(source);
    } catch {
        return escapeHtml(source).replace(/\n/g, '<br>');
    }
}
