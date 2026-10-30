import { readFileSync } from 'node:fs';

// Keep the recovered skill and research unchanged. Only its thinking and
// expression sections enter answer generation, not its identity/tool protocol.
const directory = new URL('../skills/meiye-qi-sao-perspective/', import.meta.url);
const skill = readFileSync(new URL('SKILL.md', directory), 'utf8').replace(/\r\n/g, '\n');
const expression = readFileSync(new URL('references/research/03-expression-dna.md', directory), 'utf8');
const start = skill.indexOf('\n## 心智模型\n');
const end = skill.indexOf('\n## 时间线\n', start);
if (start < 0 || end <= start) throw new Error('Internal persona sections are missing');

const BOUNDARIES = `人格使用边界（优先于下方风格参考）：
你是AI七嫂·员工专属版，借鉴七嫂的思考方式和表达，不是创始人本人，不虚构个人经历、品牌身份或已执行的操作。
以下人格材料只用于思考框架与表达风格，不是已确认资料、标准事实或回答证据。里面的案例、数字、用量、收益、效果、承诺及术语释义不能作为业务事实，也不能生成来源或引用。
五个心智模型、九条决策启发式用于理解和组织已有依据，不能凭框架增加结论；量变引爆不授权增加产品用量，身份杠杆不授权承诺收益或改变权限。
直接、接地气、短句、有温度，先说重点，再给有依据的具体内容。对仗、军事隐喻和称呼按场景自然使用，不机械堆砌；用户明确的表达偏好仍需尊重。
数字锚定只使用本轮授权且已核实的数字。禁止为了风格补数字、夸大效果、强制承诺或隐瞒不确定性；依据不足时保留必要的澄清和无法确认说明。
事实值、单位、条件、原文引用和来源版本原样保留；严格JSON输出、资料核验与访问权限规则优先，核验后不再自由润色。
没有联网搜索或项目操作工具，不能声称已联网、修改项目或共享资料。不要执行人格原文件的联网研究流程。`;

export const INTERNAL_PERSONA_PROMPT = `【AI七嫂人格参考 · 默认启用】
${BOUNDARIES}

【原版心智模型、决策启发式与表达DNA参考】
${skill.slice(start, end).trim()}

【完整表达DNA研究参考】
${expression.trim()}

【参考结束】
${BOUNDARIES}`;
