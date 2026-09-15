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

export interface ParsedPasteLine {
  /** 同一カードに複数ラインがある場合の丸数字（①=1）。なければ null */
  ordinal: number | null;
  /** 開始時刻行（"23:30"）。なければ null */
  startTime: string | null;
  /** ハンデを出している側（貼られた表記そのまま） */
  givingTeamRaw: string;
  /** ハンデを貰う側（貼られた表記そのまま） */
  receivingTeamRaw: string;
  /** 台帳の英語表記の候補（未解決なら空） */
  givingCandidates: readonly string[];
  receivingCandidates: readonly string[];
  /** 貼られたハンデ表記そのまま（正規化しない） */
  handicapRaw: string;
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

/** 「23:30」「23時半」などの開始時刻行。チーム行ではない */
function parseTimeLine(rawLine: string): string | null {
  const rest = normalizeBrackets(rawLine).trim();
  const m = /^(?:(\d{1,2})[:：](\d{2})|(\d{1,2})時(?:(半)|(\d{1,2})分?)?)$/.exec(rest);
  if (!m) return null;
  const hh = (m[1] ?? m[3])!.padStart(2, "0");
  const mm = m[2] ?? (m[4] ? "30" : (m[5] ?? "0").padStart(2, "0"));
  return `${hh}:${mm.padStart(2, "0")}`;
}

function parseTeamLine(rawLine: string): { ordinal: number | null; team: string; handicap: string | null } {
  const { ordinal, rest } = stripOrdinal(normalizeBrackets(rawLine).trim());
  const m = /^(.*?)<([^<>]*)>$/.exec(rest);
  if (m) return { ordinal, team: m[1].trim(), handicap: m[2].trim() };
  return { ordinal, team: rest, handicap: null };
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

  return blocks.map((source, i) => {
    const index = i + 1;
    const lines = source.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length < 2) {
      return { index, source, line: null, error: "行が足りない（チーム 2 行が要る）" };
    }

    let startTime: string | null = null;
    const teamLines: string[] = [];
    for (const l of lines) {
      const t = parseTimeLine(l);
      if (t !== null && teamLines.length === 1) {
        startTime = t; // チームとチームの間の時刻行
        continue;
      }
      if (t !== null && teamLines.length === 0) {
        startTime = t; // 先頭の時刻行
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
        startTime,
        givingTeamRaw: giving.team,
        receivingTeamRaw: receiving.team,
        givingCandidates: resolveTeamCandidates(giving.team),
        receivingCandidates: resolveTeamCandidates(receiving.team),
        handicapRaw,
      },
    };
  });
}
