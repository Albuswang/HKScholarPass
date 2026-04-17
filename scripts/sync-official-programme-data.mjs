import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT, "index.html");
const OUTPUT_PATH = path.join(ROOT, "official-programme-data.js");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const nowIso = new Date().toISOString().slice(0, 10);
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=");
    return [key, value];
  })
);

const selectedSchool = args.get("school") || "";
const limit = Number(args.get("limit") || 0);
const concurrency = Number(args.get("concurrency") || 10);

function cleanText(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function cleanRichText(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n")
    .replace(/<\/li>\s*<li[^>]*>/gi, "\n")
    .replace(/<\/div>\s*<div[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#39;|&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function compact(value = "") {
  return cleanText(value)
    .replace(/\s*:\s*/g, ": ")
    .replace(/(\d{1,2}):\s+(\d{2})(?=\s*(?:am|pm|noon|GMT|\)|,|;|$))/gi, "$1:$2")
    .trim();
}

function compactRich(value = "") {
  return cleanRichText(value)
    .split("\n")
    .map((line) => line.replace(/\s*:\s*/g, ": ").replace(/(\d{1,2}):\s+(\d{2})(?=\s*(?:am|pm|noon|GMT|\)|,|;|$))/gi, "$1:$2").trim())
    .filter(Boolean)
    .join("\n");
}

async function fetchText(url, { timeoutMs = 25000, maxChars = 0, retries = 2 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8"
      },
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!maxChars) return await response.text();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    text += decoder.decode();
    return text;
  } catch (error) {
    if (retries > 0) {
      await delay(350);
      return fetchText(url, { timeoutMs, maxChars, retries: retries - 1 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, worker, count = concurrency) {
  const results = [];
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
      await delay(25);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, count) }, run));
  return results;
}

function extractScript(indexHtml) {
  const match = indexHtml.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Cannot locate Babel script in index.html");
  return match[1];
}

function hkuApplyKey(program, faculty) {
  return `${faculty?.name || ""}::${program[1]}`;
}

function hkuProgrammeTitle(program) {
  const [degree, name] = program;
  if (degree === "MSc") return `Master of Science in ${name}`;
  if (degree === "MA") return `Master of Arts in ${name}`;
  if (degree === "LLM") return `Master of Laws in ${name}`;
  if (degree === "MDS") return `Master of Dental Surgery in ${name}`;
  if (degree === "MSocSc") return `Master of Social Sciences in the field of ${name}`;
  if (degree === "Master") return `Master of ${name}`;
  if (degree === "Juris Doctor") return "Juris Doctor";
  return `${degree} ${name}`;
}

function hkuSlugify(value) {
  return value.toLowerCase().replace(/&/g, "and").replace(/\u00a0/g, " ").replace(/\s+/g, "-");
}

const HKU_PROGRAMME_SLUG_OVERRIDES = {
  "建筑学院::Architecture": "master-of-architecture-(non-hk-and-international-applicants)-foa",
  "建筑学院::Advanced Architectural Design": "master-of-science-in-advanced-architectural-design-(sep-2026)-foa",
  "建筑学院::Housing Management": "master-of-urban-studies-and-housing-management-(housing-management-(professional)-stream)-foa",
  "建筑学院::Urban Design": "master-of-urban-design-(for-general-applicants)-foa",
  "建筑学院::Urban Planning": "master-of-science-in-urban-planning-(urban-and-regional-planning-stream)-foa",
  "文学院::Art History": "master-of-arts-in-the-field-of-art-history-arts",
  "文学院::Chinese Historical Studies": "master-of-arts-in-the-field-of-chinese-historical-studies-arts",
  "文学院::Chinese Language and Literature": "master-of-arts-in-the-field-of-chinese-language-and-literature-arts",
  "文学院::Creative Communications": "master-of-arts-in-the-field-of-creative-communications-arts",
  "文学院::English Studies": "master-of-arts-in-the-field-of-english-studies-arts",
  "文学院::Hong Kong History": "master-of-arts-in-the-field-of-hong-kong-history-arts",
  "文学院::Linguistics": "master-of-arts-in-the-field-of-linguistics-arts",
  "文学院::Literary and Cultural Studies": "master-of-arts-in-the-field-of-literary-and-cultural-studies-arts",
  "文学院::Music Studies": "master-of-arts-in-the-field-of-music-studies-arts",
  "文学院::Translation": "master-of-arts-in-the-field-of-translation-arts",
  "商学院::Business Analytics": "master-of-science-in-business-analytics-hkubs",
  "商学院::Marketing": "master-of-science-in-marketing-hkubs",
  "商学院::Climate Governance and Risk Management": "master-of-climate-governance-and-risk-management-socsc",
  "计算与数据科学学院（CDS）::Computer Science": "master-of-science-in-computer-science-general-stream-cds",
  "计算与数据科学学院（CDS）::Artificial Intelligence": "master-of-science-in-artificial-intelligence-sci",
  "牙医学院::Community Dentistry": "master-of-science-in-community-dentistry-facdent",
  "牙医学院::Implant Dentistry": "master-of-science-in-implant-dentistry-facdent",
  "教育学院::Speech-Language Pathology": "master-of-science-in-speech-language-pathology",
  "工程学院::Civil Engineering": "master-of-science-in-engineering-(civil-engineering)-general-stream-engg",
  "工程学院::Electrical and Electronic Engineering": "master-of-science-in-engineering-(electrical-and-electronic-engineering)-general-stream-engg",
  "工程学院::Environmental Engineering": "master-of-science-in-engineering-(civil-engineering)-environmental-engineering-stream-engg",
  "工程学院::Geotechnical Engineering": "master-of-science-in-engineering-(civil-engineering)-geotechnical-engineering-stream-engg",
  "工程学院::Infrastructure Project Management": "master-of-science-in-engineering-(infrastructure-engineering-and-management)-infrastructure-project-management-stream-engg",
  "工程学院::Structural Engineering": "master-of-science-in-engineering-(civil-engineering)-structural-engineering-stream-engg",
  "法学院::Common Law": "master-of-common-law-law",
  "法学院::Medical Ethics and Law": "master-of-laws-in-medical-ethics-and-law-law",
  "李嘉诚医学院::Advanced Pharmacy": "master-of-advanced-pharmacy-med",
  "李嘉诚医学院::Global Health Leadership and Management": "master-of-global-health-leadership-and-management-med",
  "理学院::Applied Geosciences": "msc-in-the-field-of-applied-geosciences-sci",
  "理学院::Artificial Intelligence in Science": "master-of-science-in-artificial-intelligence-sci",
  "理学院::Food Industry Management and Marketing": "master-of-science-in-the-field-of-food-industry:-management-and-marketing-sci",
  "理学院::Food Safety and Toxicology": "master-of-science-in-the-field-of-food-safety-and-toxicology-sci",
  "理学院::Physics": "master-of-science-in-the-field-of-physics-sci",
  "理学院::Statistics": "master-of-statistics-cds",
  "社会科学学院::China Development Studies": "master-of-arts-in-china-development-studies-socsc",
  "社会科学学院::Counselling": "master-of-social-sciences-in-the-field-of-counselling-socsc",
  "社会科学学院::Criminology": "master-of-social-sciences-in-the-field-of-criminology-socsc",
  "社会科学学院::International and Public Affairs": "master-of-international-and-public-affairs-socsc",
  "社会科学学院::Media, Culture and Creative Cities": "master-of-social-sciences-in-the-field-of-media,-culture-and-creative-cities-socsc",
  "社会科学学院::Nonprofit Management": "master-of-social-sciences-in-the-field-of-nonprofit-management-socsc",
  "社会科学学院::Psychology": "master-of-social-sciences-in-the-field-of-psychology-socsc",
  "社会科学学院::Sustainability Leadership and Governance": "msocsc-sustainability-leadership-and-governance",
  "社会科学学院::Transport Policy and Planning": "master-of-transport-policy-and-planning-socsc"
};

const HKU_SUFFIX = {
  "建筑学院": "foa",
  "文学院": "arts",
  "商学院": "hkubs",
  "计算与数据科学学院（CDS）": "cds",
  "牙医学院": "facdent",
  "教育学院": "edu",
  "工程学院": "engg",
  "法学院": "law",
  "李嘉诚医学院": "med",
  "理学院": "sci",
  "社会科学学院": "socsc"
};

function hkuOfficialProgrammeTitle(program, faculty) {
  const key = hkuApplyKey(program, faculty);
  const artsFieldNames = [
    "Art History",
    "Chinese Historical Studies",
    "Chinese Language and Literature",
    "Creative Communications",
    "English Studies",
    "Hong Kong History",
    "Linguistics",
    "Literary and Cultural Studies",
    "Music Studies",
    "Translation"
  ];
  const scienceFieldNames = ["Food Industry Management and Marketing", "Food Safety and Toxicology", "Physics"];
  if (faculty?.name === "文学院" && artsFieldNames.includes(program[1])) return `Master of Arts in the field of ${program[1]}`;
  if (faculty?.name === "理学院" && scienceFieldNames.includes(program[1])) return `Master of Science in the field of ${program[1]}`;
  if (key === "文学院::Buddhist Counselling") return "Master of Buddhist Counselling";
  if (key === "文学院::Buddhist Studies") return "Master of Buddhist Studies";
  if (key === "商学院::Business Analytics") return "Master of Science in Business Analytics";
  if (key === "商学院::Marketing") return "Master of Science in Marketing";
  if (key === "李嘉诚医学院::Advanced Pharmacy") return "Master of Advanced Pharmacy";
  if (faculty?.name === "工程学院") return `Master of Science in Engineering (${program[1]})`;
  return hkuProgrammeTitle(program);
}

function hkuProgrammeUrl(program, faculty) {
  const slug =
    HKU_PROGRAMME_SLUG_OVERRIDES[hkuApplyKey(program, faculty)] ||
    `${hkuSlugify(hkuOfficialProgrammeTitle(program, faculty))}-${HKU_SUFFIX[faculty.name] || ""}`;
  return `https://portal.hku.hk/tpg-admissions/programme-details?programme=${encodeURIComponent(slug)}&mode=0`;
}

function extractHkuHighlight(html, title) {
  const re = new RegExp(
    `<div class="highlights-item-title">\\s*${title}\\s*<\\/div>\\s*<div class="highlights-item-description">([\\s\\S]*?)<\\/div>`,
    "i"
  );
  return compactRich(html.match(re)?.[1] || "");
}

function parseHku(html) {
  return {
    tuition: extractHkuHighlight(html, "Fees").replace(/Message from Faculty:.*/i, "").replace(/\*A .*/i, "").trim(),
    duration: extractHkuHighlight(html, "Expected Duration"),
    status: extractHkuHighlight(html, "Application Deadline")
  };
}

function parsePolyUList(html) {
  const rows = [];
  const re = /<a class="programme[\s\S]*?href="([^"]+)"[\s\S]*?<div class="study-mode-and-duration">\s*([\s\S]*?)<\/div>[\s\S]*?<div class="title">([\s\S]*?)<\/div>[\s\S]*?<div class="deadline-section">([\s\S]*?)<\/div>\s*<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = new URL(match[1], "https://www.polyu.edu.hk").toString();
    const duration = compact(match[2]);
    const rawTitle = compact(match[3]);
    const title = rawTitle.split(" - ")[0];
    const deadline = compact(match[4]);
    rows.push({ href, title, rawTitle, duration, deadline });
  }
  return rows;
}

function parsePolyUDetail(html) {
  const text = cleanText(html);
  const fee = extractPolyUField(html, "field-prog-tuition-fee") ||
    text.match(/Tuition Fee\s+(.+?)\s+(?:Scholarship|Student Message|Entrance Requirements|Remarks|Application Deadline|Additional Documents Required)/i)?.[1] || "";
  const mode = cleanText(html.match(/<div class="text">STUDY MODE<\/div>\s*<div class="data">([\s\S]*?)<\/div>/i)?.[1] || "");
  const normalDuration = cleanRichText(html.match(/<div class="text">DURATION<\/div>\s*<div class="data">([\s\S]*?)<\/div>/i)?.[1] || "");
  const duration = mode && normalDuration ? `${mode}: ${normalDuration}` : (text.match(/STUDY MODE\s+(.+?)\s+CREDIT REQUIRED/i)?.[1] || "").replace(/\b(Full-time|Part-time|Mixed Mode|Mixed-mode)\s+DURATION\s+/gi, "$1: ");
  const deadline = extractPolyUDeadline(html) ||
    text.match(/Application Deadline\s+(.+?)\s+(?:What's New|Tuition Fee|Entrance Requirements|Programme Leader)/i)?.[1] || "";
  return {
    tuition: compactRich(fee),
    duration: compact(duration),
    status: compactRich(deadline)
  };
}

function extractPolyUField(html, fieldClass) {
  const index = html.indexOf(`field--${fieldClass}`);
  if (index < 0) return "";
  const chunk = html.slice(index, html.indexOf('<div class="field ', index + 20) > index ? html.indexOf('<div class="field ', index + 20) : index + 6000);
  const item = chunk.match(/<div class="field__item">([\s\S]*?)<\/div>\s*$/i)?.[1] ||
    chunk.match(/<div class="field__item">([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] || "";
  return compactRich(item);
}

function extractPolyUDeadline(html) {
  const index = html.indexOf('<div class="prog-application-deadline">');
  if (index < 0) return "";
  const end = html.indexOf('<div class="whats-new-container">', index);
  const chunk = html.slice(index, end > index ? end : index + 6000);
  return compactRich(chunk);
}

const CUHK_PROGRAMME_PATHS = [
  "arts",
  "business-administration",
  "education",
  "engineering",
  "inter-faculty",
  "law",
  "medicine",
  "science",
  "social-science"
];

function formatModeValues(modes, values) {
  if (!values.length) return "";
  const normalizedValues = values.map((value) => (/^\d+(?:\.\d+)?$/.test(value) ? `${value} ${value === "1" ? "year" : "years"}` : value));
  if (modes.length === values.length && values.length > 1) {
    return normalizedValues.map((value, index) => `${modes[index]}: ${value}`).join("\n");
  }
  return normalizedValues.join("\n");
}

function parseCuhkProgrammes(html, pageUrl) {
  const blocks = html
    .split(/<div class="container-content programme-details programme_content title-section-center"/)
    .slice(1)
    .map((block) => `<div class="container-content programme-details programme_content title-section-center"${block}`);

  return blocks.map((block) => {
    const programmeId = block.match(/id="programme_(\d+)"/i)?.[1] || "";
    const rawTitle = cleanText(block.match(/<div class="progamme-details-title">([\s\S]*?)<\/div>/i)?.[1] || "");
    const rows = {};
    for (const row of block.split(/<div class="programme-details-row">/).slice(1)) {
      const label = cleanText(row.match(/<div class="programme-details-tb-txt">([\s\S]*?)<\/div>/i)?.[1] || "");
      if (!label) continue;
      const values = [...row.matchAll(/<div class="_[^"]* programme-details-col">\s*<div>([\s\S]*?)<\/div>\s*<\/div>/gi)]
        .map((match) => compactRich(match[1]))
        .filter(Boolean);
      rows[label] = values;
    }
    const modes = rows["Study Mode"] || [];
    const duration = formatModeValues(modes, rows["Normative Study Period"] || []);
    const tuition = formatModeValues(modes, rows["Tuition Fee"] || []);
    const status = (rows["Application Deadline"] || []).join("\n");
    return { title: rawTitle, rawTitle, duration, tuition, status, href: programmeId ? `${pageUrl}#programme_${programmeId}` : pageUrl };
  }).filter((row) => row.title && !/MPhil|PhD/i.test(row.rawTitle));
}

async function loadCuhkCandidates() {
  const pages = await mapLimit(
    CUHK_PROGRAMME_PATHS,
    async (programmePath) => {
      const url = `https://www.gs.cuhk.edu.hk/admissions/programme/${programmePath}`;
      try {
        const html = await fetchText(url, { timeoutMs: 60000 });
        return parseCuhkProgrammes(html, url);
      } catch (error) {
        return [{ title: "", error: `${url}: ${error.message}` }];
      }
    },
    Math.min(concurrency, 4)
  );
  return pages.flat();
}

function extractHkustToken(html) {
  return html.match(/name=token_post[^>]*value="([^"]+)"/i)?.[1] || "official";
}

async function loadHkustCandidates() {
  const listHtml = await fetchText("https://prog-crs.hkust.edu.hk/pgprog/2026-27", { timeoutMs: 45000 });
  const token = extractHkustToken(listHtml);
  const params = new URLSearchParams({
    token_post: token,
    is_s: "Y",
    keyword: "",
    year: "2026-27",
    "check-all-degree-option": "Y",
    "check-allsub-degree-option1": "Y",
    "check-allsub-degree-option2": "Y"
  });
  for (const school of ["SSCI", "SENG", "SBM", "SHSS", "IPO"]) params.append("school[]", school);
  const resultHtml = await fetchText(`https://prog-crs.hkust.edu.hk/pgprog/print_result.php?${params}`, { timeoutMs: 45000 });
  const candidates = [];
  for (const match of resultHtml.matchAll(/<a[^>]+href="(\/pgprog\/2026-27\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawTitle = compact(match[2]);
    const pieces = rawTitle.split(/\s+/);
    const degree = pieces.at(-1) || "";
    const title = rawTitle
      .replace(/\s+(MSc|MA|MBA|MPA|MPP|MPhil|PhD|MPhil \/ PhD)$/i, "")
      .replace(/^(School of Engineering|Business and Management|Science|Humanities and Social Science|Public Policy|Interdisciplinary Programs Office)\s+/i, "")
      .replace(/^[A-Z][A-Za-z &-]+\s+(?=[A-Z][a-z])/g, "")
      .trim();
    if (/MPhil|PhD/i.test(degree)) continue;
    candidates.push({
      title,
      rawTitle,
      href: new URL(match[1], "https://prog-crs.hkust.edu.hk").toString()
    });
  }
  return candidates;
}

function extractHkustRow(html, label) {
  const re = new RegExp(
    `<div class="block-row-heading">\\s*${label}\\s*<\\/div>\\s*<div class="block-row-content">([\\s\\S]*?)<\\/div>\\s*<\\/div>`,
    "i"
  );
  return compactRich(html.match(re)?.[1] || "");
}

function parseHkustDetail(html) {
  return {
    tuition: extractHkustRow(html, "Program Fee"),
    duration: compact([extractHkustRow(html, "Mode Of Study"), extractHkustRow(html, "Normative Program Duration")].filter(Boolean).join(": ")),
    status: extractHkustRow(html, "Application Deadlines")
  };
}

function normalize(value = "") {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function bestMatch(programName, candidates, program = []) {
  const target = normalize(programName);
  const degree = (program[0] || "").toLowerCase();
  const targets = [target];
  if (degree === "mba" && target.includes("business administration")) targets.push("mba");
  const words = target.split(" ").filter((word) => word.length > 1);
  let best = null;
  for (const candidate of candidates) {
    const name = normalize(candidate.title || "");
    const rawTitle = normalize(candidate.rawTitle || "");
    let score = Math.max(...targets.map((item) => (name === item ? 100 : name.includes(item) || item.includes(name) ? 40 : 0)));
    for (const word of words) if (name.includes(word)) score += 2;
    if (/doctor/.test(rawTitle) && !/^doctor$/i.test(program[0] || "")) score -= 80;
    if (/postgraduate diploma|pgd/.test(rawTitle) && !/pgd/i.test(program[0] || "")) score -= 20;
    if (degree.includes("msc") && /master of science|msc/.test(rawTitle)) score += 20;
    if (degree === "mba" && /\bmba\b/.test(rawTitle)) score += 30;
    if (degree.includes("master") && /master/.test(rawTitle)) score += 15;
    if (degree.includes("ma") && /master of arts| ma /.test(` ${rawTitle} `)) score += 15;
    if (!best || score > best.score) best = { score, candidate };
  }
  return best?.score >= 6 ? best.candidate : null;
}

function programmeKey(school, faculty, program) {
  return `${school.id}::${faculty.name}::${program[1]}`;
}

async function main() {
  const indexHtml = await fs.readFile(INDEX_PATH, "utf8");
  const script = extractScript(indexHtml);
  const dataSlice = script.slice(0, script.indexOf("function SectionTitle"));
  const sandbox = {
    URLSearchParams,
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {},
    window: {},
    document: {},
    encodeURIComponent
  };
  const vm = await import("node:vm");
  vm.createContext(sandbox);
  vm.runInContext(dataSlice, sandbox);
  const schools = vm.runInContext("APP_DATA.schools", sandbox).filter((school) => !selectedSchool || school.id === selectedSchool);
  const output = {};
  const failures = [];

  for (const school of schools) {
    console.log(`\n[${school.short}] 开始同步`);
    if (school.id === "hku") {
      const rows = school.faculties.flatMap((faculty) =>
        faculty.programs.map((program) => ({ school, faculty, program, url: hkuProgrammeUrl(program, faculty) }))
      );
      const scopedRows = limit ? rows.slice(0, limit) : rows;
      await mapLimit(
        scopedRows,
        async (row) => {
          try {
            const html = await fetchText(row.url, { timeoutMs: 30000, maxChars: 460000 });
            const parsed = parseHku(html);
            if (!parsed.tuition && !parsed.duration && !parsed.status) throw new Error("未解析到 HKU highlights");
            output[programmeKey(row.school, row.faculty, row.program)] = {
              ...parsed,
              url: row.url,
              source: "HKU official programme detail",
              updatedAt: nowIso
            };
          } catch (error) {
            failures.push({ school: school.short, program: programmeKey(row.school, row.faculty, row.program), url: row.url, error: error.message });
          }
        },
        Math.min(concurrency, 12)
      );
    }

    if (school.id === "polyu") {
      try {
        const listUrl = "https://www.polyu.edu.hk/study/pg/taught-postgraduate/find-your-programmes-tpg";
        const html = await fetchText(listUrl, { timeoutMs: 45000 });
        const candidates = parsePolyUList(html);
        const rows = school.faculties.flatMap((faculty) => faculty.programs.map((program) => ({ school, faculty, program })));
        const scopedRows = limit ? rows.slice(0, limit) : rows;
        await mapLimit(
          scopedRows,
          async (row) => {
            try {
              const match = bestMatch(row.program[1], candidates, row.program);
              if (!match) throw new Error("未在 PolyU 列表匹配到专业");
              const detailHtml = await fetchText(match.href, { timeoutMs: 30000, maxChars: 150000 });
              const parsed = parsePolyUDetail(detailHtml);
              output[programmeKey(row.school, row.faculty, row.program)] = {
                tuition: parsed.tuition,
                duration: parsed.duration || match.duration,
                status: parsed.status || match.deadline,
                url: match.href,
                source: "PolyU official programme detail",
                updatedAt: nowIso
              };
            } catch (error) {
              failures.push({ school: school.short, program: programmeKey(row.school, row.faculty, row.program), error: error.message });
            }
          },
          Math.min(concurrency, 10)
        );
      } catch (error) {
        failures.push({ school: school.short, program: "PolyU list", error: error.message });
      }
    }

    if (school.id === "cuhk") {
      try {
        const candidates = await loadCuhkCandidates();
        for (const candidate of candidates.filter((candidate) => candidate.error)) {
          failures.push({ school: school.short, program: "CUHK list", error: candidate.error });
        }
        const rows = school.faculties.flatMap((faculty) => faculty.programs.map((program) => ({ school, faculty, program })));
        const scopedRows = limit ? rows.slice(0, limit) : rows;
        for (const row of scopedRows) {
          const match = bestMatch(row.program[1], candidates, row.program);
          if (!match) {
            failures.push({ school: school.short, program: programmeKey(row.school, row.faculty, row.program), error: "未在 CUHK 官方项目页匹配到专业" });
            continue;
          }
          output[programmeKey(row.school, row.faculty, row.program)] = {
            tuition: match.tuition,
            duration: match.duration,
            status: match.status,
            url: match.href,
            source: "CUHK official programme detail",
            updatedAt: nowIso
          };
        }
      } catch (error) {
        failures.push({ school: school.short, program: "CUHK list", error: error.message });
      }
    }

    if (school.id === "hkust") {
      try {
        const candidates = await loadHkustCandidates();
        const rows = school.faculties.flatMap((faculty) => faculty.programs.map((program) => ({ school, faculty, program })));
        const scopedRows = limit ? rows.slice(0, limit) : rows;
        await mapLimit(
          scopedRows,
          async (row) => {
            try {
              const match = bestMatch(row.program[1], candidates, row.program);
              if (!match) throw new Error("未在 HKUST 官方目录匹配到专业");
              const html = await fetchText(match.href, { timeoutMs: 30000, maxChars: 160000 });
              const parsed = parseHkustDetail(html);
              output[programmeKey(row.school, row.faculty, row.program)] = {
                tuition: parsed.tuition,
                duration: parsed.duration,
                status: parsed.status,
                url: match.href,
                source: "HKUST official programme detail",
                updatedAt: nowIso
              };
            } catch (error) {
              failures.push({ school: school.short, program: programmeKey(row.school, row.faculty, row.program), error: error.message });
            }
          },
          Math.min(concurrency, 8)
        );
      } catch (error) {
        failures.push({ school: school.short, program: "HKUST list", error: error.message });
      }
    }

    if (!["hku", "cuhk", "hkust", "polyu"].includes(school.id)) {
      failures.push({
        school: school.short,
        program: `${school.short} all`,
        error: "暂未自动写入：该校官网需要专用解析/浏览器绕过，脚本保留失败清单以免写入猜测数据"
      });
    }
  }

  const js = `// Auto-generated by scripts/sync-official-programme-data.mjs on ${nowIso}\n` +
    `window.OFFICIAL_PROGRAMME_DATA = ${JSON.stringify(output, null, 2)};\n` +
    `window.OFFICIAL_PROGRAMME_DATA_FAILURES = ${JSON.stringify(failures, null, 2)};\n`;
  await fs.writeFile(OUTPUT_PATH, js, "utf8");
  console.log(`\n已写入 ${OUTPUT_PATH}`);
  console.log(`成功 ${Object.keys(output).length} 条，失败/跳过 ${failures.length} 条`);
  if (failures.length) {
    console.log("失败样例：");
    console.log(JSON.stringify(failures.slice(0, 12), null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
