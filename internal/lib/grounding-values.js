import { fail } from './errors.js';

const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    壹: 1, 贰: 2, 貳: 2, 叁: 3, 參: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9 };
const POWERS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000 };
const CJK = '零〇一二两兩三四五六七八九十百千万亿壹贰貳叁參肆伍陆柒捌玖拾佰仟萬億';

export function normalizeNumerals(value) {
    return String(value || '').normalize('NFKC').replace(new RegExp('[' + CJK + ']+', 'g'), token => {
        if ([...token].every(character => DIGITS[character] !== undefined)) return [...token].map(character => DIGITS[character]).join('');
        let total = 0, section = 0, number = 0;
        for (const character of token) {
            if (DIGITS[character] !== undefined) number = DIGITS[character];
            else {
                const power = POWERS[character];
                if (power < 10000) { section += (number || 1) * power; number = 0; }
                else { section = (section + number) * power; total += section; section = 0; number = 0; }
            }
        }
        return String(total + section + number);
    });
}

export function validDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
        || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail(400, 'INVALID_GROUNDING_DATE', '有效日期需要填写真实的 YYYY-MM-DD 日期。');
    return value;
}

export function shanghaiDate(now = Date.now()) {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
    const get = key => parts.find(part => part.type === key).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

export function evidenceDates(value) {
    const body = normalizeNumerals(value);
    const dates = [...body.matchAll(/((?:19|20)\d{2})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})(?:日|号)?/g)].flatMap(match => {
        const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
        try { return [validDate(date)]; } catch { return []; }
    });
    const years = [...body.matchAll(/(?:^|[^\d])((?:19|20)\d{2})(?:年|[-/])/g)].map(match => match[1]);
    return { dates, years };
}

export function needsConditions(value) { return /仅限|限于|会员|起订|满\s*[\d零〇一二三四五六七八九十百千万两]|以上|以下|不含|税后|优惠|折扣|赠送|预付|定金|预约|首单|新客|老客/.test(value); }
export function needsDates(value) { return evidenceDates(value).years.length > 0 || /期间|失效|有效至|截至|限时|当日|当月|今年|去年/.test(value); }

export function applicabilityInput(input, evidence, confirming = false) {
    const conditions = String(input.conditions || '').trim();
    if (conditions.length > 3000 || conditions && !evidence.includes(conditions)) fail(422, 'GROUNDING_CONDITIONS_MISMATCH', '适用条件必须摘录当前证据原文。');
    const validFrom = validDate(input.validFrom), validUntil = validDate(input.validUntil);
    if (Boolean(validFrom) !== Boolean(validUntil) || validFrom && validFrom > validUntil) fail(400, 'INVALID_GROUNDING_DATE', '请同时填写起止日期，截止日期不能早于生效日期。');
    if (validFrom) {
        const { dates, years } = evidenceDates(evidence);
        const sorted = [...dates].sort(), sortedYears = [...years].sort();
        const earliest = sorted.length >= 2 ? sorted[0] : sortedYears.length ? sortedYears[0] + '-01-01' : null;
        const latest = sorted.length >= 2 ? sorted.at(-1) : sortedYears.length ? sortedYears.at(-1) + '-12-31' : null;
        if (!earliest || validFrom < earliest || validUntil > latest) fail(422, 'GROUNDING_DATE_EVIDENCE_MISMATCH', '有效期超出来源明确提供的日期范围，请补充或修订原资料。');
    }
    if (confirming && needsDates(evidence) && !validFrom) fail(409, 'GROUNDING_DATES_REQUIRED', '证据带有时效限定，请填写有原文依据的生效与截止日期后再确认。');
    if (confirming && needsConditions(evidence) && conditions !== evidence.trim()) fail(409, 'GROUNDING_CONDITIONS_REQUIRED', '证据有适用限制，请将完整证据原文填入适用条件后再确认。');
    return { conditions, validFrom, validUntil };
}

export function queryDateRange(query, now = Date.now()) {
    const body = normalizeNumerals(query), today = shanghaiDate(now), currentYear = Number(today.slice(0, 4));
    const { dates, years } = evidenceDates(body);
    if (dates.length === 1) return { from: dates[0], until: dates[0], label: dates[0] };
    if (dates.length > 1) return { ambiguous: true, label: '具体有效日期' };
    let year = years.length === 1 ? years[0] : null;
    if (years.length > 1) return { ambiguous: true, label: '具体有效年份' };
    if (/前年/.test(body)) year = String(currentYear - 2);
    else if (/去年/.test(body)) year = String(currentYear - 1);
    else if (/今年|本年度/.test(body)) year = String(currentYear);
    if (/昨天|上周|上个月|上月|以前|之前|过去|历史|旧版|老版/.test(body) && !year) return { ambiguous: true, label: '具体有效日期' };
    return year ? { from: year + '-01-01', until: year + '-12-31', label: year + '年' } : { from: today, until: today, label: '当前有效日期' };
}

export function factApplies(fact, query, now) {
    const range = queryDateRange(query, now);
    if (range.ambiguous) return false;
    if (needsDates(fact.evidence || '') && (!fact.validFrom || !fact.validUntil)) return false;
    if (fact.validFrom && (fact.validFrom > range.from || fact.validUntil < range.until)) return false;
    return true;
}

export function conditionsMatched(fact, query) {
    return !fact.conditions || normalizeNumerals(query).replace(/\s/g, '').includes(normalizeNumerals(fact.conditions).replace(/\s/g, ''));
}

const NUMERIC = new RegExp('[+\\-−]?(?:\\p{N}+(?:[.,]\\p{N}+)*|百分之[' + CJK + ']+|[' + CJK + ']+)(?:\\s*(?:人民币|小时|分钟|毫升|毫克|千克|公斤|元|圆|圓|块|塊|天|日|周|次|瓶|支|盒|件|套|个|份|项|位|粒|颗|片|滴|枚|包|袋|箱|单|家|组|名|条|双|克|升|米|度|岁|年|月|%|％))?', 'gu');
export function numericSignature(value) {
    return [...String(value).matchAll(NUMERIC)].filter(match => /\p{N}/u.test(match[0]) || match[0].length > 1
        || /[第为是用共仅需]/.test(String(value)[match.index - 1] || '') || !/[\u3400-\u9fff]/.test(String(value)[match.index + match[0].length] || ''))
        .map(match => match[0].normalize('NFKC').replace(/\s/g, '')).sort();
}
export function numbersPreserved(original, rewritten) { return JSON.stringify(numericSignature(original)) === JSON.stringify(numericSignature(rewritten)); }
