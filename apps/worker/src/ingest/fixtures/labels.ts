/**
 * Hand-checked labels for the Day 0 dumps in `data/dumps/`.
 *
 * Every message in both dumps was read. NEW_CALL and SCANNER_CARD were
 * enumerated from the address-bearing messages before the classifier existed;
 * MILESTONE was enumerated by reading the full text of both channels. Anything
 * not listed here is expected to be NOISE, which is what makes this file a
 * precision test as well as a recall test: 400 messages, 113 labelled.
 *
 * If the classifier changes and a number here moves, the fix is to read the
 * message in the dump — not to edit this file to match the new output.
 */
export type Label = "NEW_CALL" | "MILESTONE" | "SCANNER_CARD";

export type LabelledDump = {
  name: string;
  file: string;
  kind: "BARE_CA" | "NARRATIVE";
  expected: Record<Label, number[]>;
  /// Messages a human would arguably label, that the classifier deliberately
  /// leaves as NOISE. Listed so the gaps are known rather than discovered
  /// later, and asserted as NOISE so a change in behaviour is visible.
  knownMisses: { id: number; text: string; why: string }[];
};

export const ALPHAS: LabelledDump = {
  name: "<private-channel>",
  file: "dump_private-channel.json",
  kind: "BARE_CA",
  expected: {
    // The call is the address alone. 1186, 1196 and 1279 are EVM and were
    // invisible to the original base58-only regex.
    NEW_CALL: [
      1084, 1092, 1100, 1103, 1111, 1114, 1133, 1162, 1165, 1172, 1186, 1196,
      1202, 1205, 1208, 1219, 1231, 1234, 1242, 1248, 1262, 1266, 1269, 1271,
      1279, 1280,
    ],
    // "3x", "2x 💆🏽‍♂️", "115x btw 🦅💧" and the cap-progression form "9k to 500k".
    MILESTONE: [1121, 1130, 1142, 1174, 1176, 1177, 1179, 1194, 1220, 1240],
    SCANNER_CARD: [],
  },
  knownMisses: [
    {
      id: 1136,
      text: "800k +",
      why: "a cap with a trailing plus is a progression the PROGRESSION pattern does not cover",
    },
    {
      id: 1115,
      text: "Got in 14k",
      why: "the caller's own entry for call 1114, posted as a separate message. Stated market cap for BARE_CA channels would mean stitching adjacent messages together — a Phase 1 ingest decision, not a classifier one",
    },
    {
      id: 1244,
      text: "Send is at 600k mc now",
      why: "about a token other than the one just called; attaching it would guess a parent",
    },
  ],
};

export const JURIX: LabelledDump = {
  name: "AlphaDesJurix",
  file: "dump_AlphaDesJurix.json",
  kind: "NARRATIVE",
  expected: {
    // Prose plus an address plus call intent. 7520 (BNB) and 7550 (HyperEVM)
    // are EVM. 7598 re-posts a token already called at 7577 — the classifier is
    // stateless, so it says NEW_CALL and the unique constraint makes it an event.
    NEW_CALL: [
      7469, 7480, 7486, 7494, 7520, 7526, 7534, 7550, 7559, 7562, 7577, 7598,
      7608, 7610, 7614, 7629, 7634, 7640, 7647, 7650, 7660, 7666, 7676,
    ],
    MILESTONE: [
      7476, 7482, 7484, 7495, 7501, 7539, 7541, 7542, 7543, 7544, 7553, 7560,
      7563, 7566, 7580, 7594, 7600, 7604, 7609, 7616, 7617, 7618, 7630, 7631,
      7643, 7646, 7653, 7654, 7657, 7663, 7678,
    ],
    // Scanner cards (💊 ☄️), migration and dex-paid cards (⚡️ 🔄 🦅 💰),
    // buy bots (@MajorBuyBot) and the Trench Track ATH card (🕊).
    SCANNER_CARD: [
      7481, 7498, 7521, 7536, 7537, 7538, 7540, 7564, 7565, 7570, 7579, 7581,
      7593, 7595, 7601, 7603, 7615, 7626, 7642, 7645, 7652, 7662, 7677,
    ],
  },
  knownMisses: [
    {
      id: 7475,
      text: "$KADU reversing nicely from 33k dip. 85k now!",
      why: "a progress update with no multiple and no ATH claim",
    },
    {
      id: 7499,
      text: "Don't fckin fade me.\n\nATH.",
      why: "claims an ATH but states no figure; an ATH with no number is not worth a row",
    },
    { id: 7644, text: "50k!.", why: "a bare figure with nothing tying it to a call" },
    {
      id: 7655,
      text: "Ggs if you caught $biketyson on my X page. It was obvious. 10x for the public.",
      why: "a retrospective boast about a call made off-channel; $biketyson was never called here, so there is nothing to attach it to",
    },
  ],
};

export const DUMPS = [ALPHAS, JURIX];
