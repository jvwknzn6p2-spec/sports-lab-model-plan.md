/**
 * サッカーのハンデ貼り付けを解析する。
 *
 * 形式は野球側（VORTE EV の一括貼り付け）と同じ:
 *   空行区切りで 1 カード、2〜3 行（チーム / 時刻 / チーム）。
 *   `<>` が付いている側が**ハンデを出している側（GIVING）**。
 *
 *   例:
 *     アーセナル<0半3>
 *     23:30
 *     チェルシー
 *
 * ハンデ表記は `handicap.ts` の SOCCER_LADDER_V1 で解釈する（野球の表とは別物）。
 * チーム名は `teamNamesJa.ts` で台帳の英語表記へ解決する。
 *
 * **解決できなかったカードは捨てずに理由つきで返す。** 「提示されたのに記録に入らなかった
 * ハンデ」が何件あったかを後から数えられないと、記録の意味が失われる（野球側で
 * 2026-08-07 に同じ轍を踏んだ）。
 *
 * ここは解析だけで、EV も推奨も計算しない。
 */
import { isValidHandicapNotation, parseHandicap } from "./handicap.ts";
import { resolveTeamCandidates } from "./teamNamesJa.ts";

/**
 * 日本語のリーグ見出し（`【プレミアリーグ】`）→ 台帳のリーグコード。
 * 見出しは対象試合の絞り込みに使う（同名カードの取り違えを防ぐ）。
 * ここに無い見出しは**リーグ不明として扱うだけ**で、カードは捨てない。
 */
export const JA_LEAGUE_TO_CODE: Readonly<Record<string, string>> = {
  プレミアリーグ: "E0",
  セリエA: "I1",
  ラリーガ: "SP1",
  ラリーガエスパニョーラ: "SP1",
  ブンデスリーガ: "D1",
  エールディビジ: "N1",
  エールディヴィジ: "N1",
  リーグアン: "F1",
  プリメイラリーガ: "P1",
  リーガポルトガル: "P1",
  ポルトガルリーグ: "P1",
  ジュピラープロリーグ: "B1",
  ベルギーリーグ: "B1",
  スコティッシュプレミアシップ: "SC0",
  スコットランドリーグ: "SC0",
  ジュピラーリーグ: "B1",
  ジュピラー: "B1",
  リーガ: "SP1",
  チャンピオンズリーグ: "CL",
  CL: "CL",
  UCL: "CL",
  ヨーロッパリーグ: "EL",
  EL: "EL",
  UEL: "EL",
  J1リーグ: "JAP",
  J1: "JAP",
  明治安田J1リーグ: "JAP",
};

/** 見出しの表記ゆれ（中黒・スペース・全角）を吸収する */
function leagueKey(name: string): string {
  return name.trim().replace(/[・･\s　]/g, "");
}

export interface ParsedPasteLine {
  /** 同一カードに複数ラインがある場合の丸数字（①=1）。なければ null */
  ordinal: number | null;
  /** `【…】` の見出しそのまま。なければ null */
  leagueRaw: string | null;
  /** 見出しから解決した台帳のリーグコード。解決できなければ null */
  leagueCode: string | null;
  /** 開始時刻行（"23:30"）。なければ null。28:00 のような深夜表記は 04:00 + startsNextDay */
  startTime: string | null;
  /** 開始時刻が 24 時以降の深夜表記だったか（翌日） */
  startsNextDay: boolean;
  /** 直前の「◯◯締切」行。なければ null */
  deadline: string | null;
  /** ハンデを出している側（貼られた表記そのまま） */
  givingTeamRaw: string;
  /** ハンデを貰う側（貼られた表記そのまま） */
  receivingTeamRaw: string;
  /** 台帳の英語表記の候補（未解決なら空） */
  givingCandidates: readonly string[];
  receivingCandidates: readonly string[];
  /** 貼られたハンデ表記そのまま（正規化しない） */
  handicapRaw: string;
  /**
   * 同じ行に 2 つ目以降のハンデがあったとき（`ビルバオ<0/7> <0/9>`）の残り。
   * 何を意味する値か（別の業者・変更前後など）は貼り付けからは分からないので、
   * **捨てずにそのまま持つだけ**にする。主の値は 1 つ目
   */
  handicapAlternatives: readonly string[];
}

export interface ParsedPasteCard {
  index: number;
  /** 元テキストのブロックそのまま */
  source: string;
  line: ParsedPasteLine | null;
  error: string | null;
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨";

/** 全角の山括弧を半角へ寄せる（中身の表記は変換しない） */
function normalizeBrackets(text: string): string {
  return text.replace(/[＜〈]/g, "<").replace(/[＞〉]/g, ">");
}

function stripOrdinal(text: string): { ordinal: number | null; rest: string } {
  const i = CIRCLED.indexOf(text.charAt(0));
  if (i >= 0) return { ordinal: i + 1, rest: text.slice(1).trim() };
  const g = /^game\s*([1-9])\s*/i.exec(text);
  if (g) return { ordinal: Number(g[1]), rest: text.slice(g[0].length).trim() };
  return { ordinal: null, rest: text.trim() };
}

/**
 * 「23:30」「23時半」などの開始時刻行。チーム行ではない。
 *
 * **深夜表記（24 時以降）に対応する。** 実物のシートは翌日未明の試合を `28:00`（= 翌 04:00）
 * `26:00` のように書く。24 を超える時刻は翌日へ送り、`nextDay` で区別できるようにする。
 * 黙って 28 時のまま扱うと日付の突合が狂う。
 */
function parseTimeLine(rawLine: string): { time: string; nextDay: boolean } | null {
  // 「(27:00)」「（27:00）」のように括弧で囲んだ書き方も時刻行（2026-10-21 の実物）
  const rest = normalizeBrackets(rawLine).trim().replace(/^[(（]\s*(.*?)\s*[)）]$/, "$1");
  const m = /^(?:(\d{1,2})[:：](\d{2})|(\d{1,2})時(?:(半)|(\d{1,2})分?)?)$/.exec(rest);
  if (!m) return null;
  let hh = Number(m[1] ?? m[3]);
  const mm = m[2] ?? (m[4] ? "30" : (m[5] ?? "0").padStart(2, "0"));
  if (hh > 47) return null; // 時刻として解釈できない
  const nextDay = hh >= 24;
  if (nextDay) hh -= 24;
  return { time: `${String(hh).padStart(2, "0")}:${mm.padStart(2, "0")}`, nextDay };
}

/** 「19:30締切」「23時00分締切」のような締切行。カードではない */
function parseDeadlineLine(rawLine: string): string | null {
  const rest = normalizeBrackets(rawLine).trim();
  const m = /^(.+?)\s*締切$/.exec(rest);
  if (!m) return null;
  const t = parseTimeLine(m[1]);
  return t ? t.time : m[1].trim();
}

function parseTeamLine(rawLine: string): { ordinal: number | null; team: string; handicap: string | null; alternatives: string[] } {
  const { ordinal, rest } = stripOrdinal(normalizeBrackets(rawLine).trim());
  // 末尾の `<…>` を全部拾う（`ビルバオ<0/7> <0/9>` のように 2 つ並ぶ書き方がある）
  const m = /^(.*?)((?:\s*<[^<>]*>)+)$/.exec(rest);
  if (m) {
    const hs = [...m[2].matchAll(/<([^<>]*)>/g)].map((x) => x[1].trim());
    return { ordinal, team: m[1].trim(), handicap: hs[0], alternatives: hs.slice(1) };
  }
  return { ordinal, team: rest, handicap: null, alternatives: [] };
}

/** `<CL>`・`<リーガ>` のように行全体が山括弧の見出し（ハンデ表記として読めるものは見出しにしない） */
function angleHeading(line: string): string | null {
  const m = /^<\s*([^<>]+?)\s*>$/.exec(normalizeBrackets(line).trim());
  if (!m || isValidHandicapNotation(m[1])) return null;
  return m[1];
}

/** 貼り付けテキストの上限（ブラウザや Issue から無制限に流し込ませない） */
export const MAX_PASTE_CHARS = 20000;
export const MAX_CARDS = 200;

/**
 * 貼り付けテキストをカードへ分解する。
 * 解決できたものだけを返すのではなく、**失敗も理由つきで全件返す**。
 */
export function parsePasteText(text: string): ParsedPasteCard[] {
  if (text.length > MAX_PASTE_CHARS) {
    throw new Error(`貼り付けが長すぎる: ${text.length} 文字（上限 ${MAX_PASTE_CHARS}）`);
  }
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\s+$/, ""))
    .filter((b) => b.trim() !== "");
  if (blocks.length > MAX_CARDS) {
    throw new Error(`カードが多すぎる: ${blocks.length} 件（上限 ${MAX_CARDS}）`);
  }

  // 見出しだけの塊は、以降のカードに効く（見出し + 空行 + カード という貼り方に対応）
  let carriedLeague: string | null = null;
  let carriedDeadline: string | null = null;
  const cards: ParsedPasteCard[] = [];

  blocks.forEach((source, i) => {
    const index = cards.length + 1;
    const lines = source.split("\n").map((l) => l.trim()).filter((l) => l !== "");

    // `【…】` の見出しを抜き出す（カード内にあっても、単独の塊でもよい）
    let leagueRaw: string | null = null;
    const body: string[] = [];
    for (const l of lines) {
      const h = /^[【\[]\s*(.+?)\s*[】\]]$/.exec(l);
      const ah = h ? null : angleHeading(l);
      if (h || ah) {
        leagueRaw = h ? h[1] : ah;
        continue;
      }
      const d = parseDeadlineLine(l);
      if (d !== null) {
        carriedDeadline = d;
        continue;
      }
      body.push(l);
    }
    if (body.length === 0) {
      // 見出し・締切だけの塊。カードとしては数えず、次以降へ引き継ぐ
      if (leagueRaw) carriedLeague = leagueRaw;
      return;
    }
    // カードの中に書いた見出し（`<CL>` + 改行 + カード）も以降のカードへ引き継ぐ（2026-10-21 の実物）
    if (leagueRaw) carriedLeague = leagueRaw;
    const effectiveLeague = leagueRaw ?? carriedLeague;
    const leagueCode = effectiveLeague ? (JA_LEAGUE_TO_CODE[leagueKey(effectiveLeague)] ?? null) : null;

    cards.push(parseCard(index, source, body, effectiveLeague, leagueCode, carriedDeadline));
  });
  return cards;
}

function parseCard(
  index: number,
  source: string,
  lines: string[],
  leagueRaw: string | null,
  leagueCode: string | null,
  deadline: string | null,
): ParsedPasteCard {
  {
    if (lines.length < 2) {
      return { index, source, line: null, error: "行が足りない（チーム 2 行が要る）" };
    }

    let startTime: string | null = null;
    let startsNextDay = false;
    const teamLines: string[] = [];
    // 先頭の通し番号だけの行（`1`）はカードの一部ではない（2026-10-15 の実物）
    if (lines.length > 2 && /^\d{1,2}$/.test(lines[0])) lines = lines.slice(1);
    for (let l of lines) {
      // 時刻行にハンデが付いた書き方（`25:30<0>`）。<0> は出し・貰いが同じ決済なので前の行の側に付ける。
      // それ以外は出し側が決められないので、推測せずに理由つきで返す
      const th = /^(.*?)\s*<([^<>]*)>$/.exec(normalizeBrackets(l).trim());
      if (th && parseTimeLine(th[1]) !== null) {
        if (th[2].trim() !== "0" || teamLines.length !== 1) {
          return { index, source, line: null, error: `時刻行にハンデ <${th[2].trim()}> が付いていて、出し側が分からない` };
        }
        teamLines[0] = `${teamLines[0]}<0>`;
        l = th[1];
      }
      const t = parseTimeLine(l);
      if (t !== null && teamLines.length <= 1) {
        startTime = t.time; // 先頭、またはチームとチームの間の時刻行
        startsNextDay = t.nextDay;
        continue;
      }
      teamLines.push(l);
    }
    if (teamLines.length !== 2) {
      return { index, source, line: null, error: `チーム行が 2 行でない（${teamLines.length} 行）` };
    }

    const a = parseTeamLine(teamLines[0]);
    const b = parseTeamLine(teamLines[1]);
    const withHc = [a, b].filter((x) => x.handicap !== null);
    if (withHc.length === 0) return { index, source, line: null, error: "ハンデ <> がどちらにも無い" };
    if (withHc.length === 2) return { index, source, line: null, error: "ハンデ <> が両側にある" };

    const giving = a.handicap !== null ? a : b;
    for (const alt of giving.alternatives) {
      if (!isValidHandicapNotation(alt)) return { index, source, line: null, error: `未定義のハンデ表記: ${alt}` };
    }
    const receiving = a.handicap !== null ? b : a;
    const handicapRaw = giving.handicap as string;
    if (!isValidHandicapNotation(handicapRaw)) {
      return { index, source, line: null, error: `未定義のハンデ表記: ${handicapRaw}` };
    }
    parseHandicap(handicapRaw); // 念のため（例外は上の検査で出ない）

    if (!giving.team) return { index, source, line: null, error: "出し側のチーム名が空" };
    if (!receiving.team) return { index, source, line: null, error: "貰い側のチーム名が空" };

    return {
      index,
      source,
      error: null,
      line: {
        ordinal: giving.ordinal ?? receiving.ordinal,
        leagueRaw,
        leagueCode,
        startTime,
        startsNextDay,
        deadline,
        givingTeamRaw: giving.team,
        receivingTeamRaw: receiving.team,
        givingCandidates: resolveTeamCandidates(giving.team),
        receivingCandidates: resolveTeamCandidates(receiving.team),
        handicapRaw,
        handicapAlternatives: giving.alternatives,
      },
    };
  }
}
