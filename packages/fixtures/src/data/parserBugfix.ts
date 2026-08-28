import type { Fixture } from "../types";

export const parserBugfix: Fixture = {
  slug: "parser-bugfix",
  title: "Stop dropping the final token when input has no trailing newline",
  author: "octo-reviewer",
  blurb: "One file, one hunk. The smallest useful review.",
  revisions: [
    {
      headSha: "1111222233334444555566667777888899990000",
      baseSha: "aaaabbbbccccddddeeeeffff0000111122223333",
      files: [
        {
          path: "src/tokenize.ts",
          previousPath: null,
          blobSha: "blob-tokenize-r1",
          status: "modified",
          patch: [
            "@@ -22,7 +22,7 @@ export function tokenize(input) {",
            "   let start = 0;",
            "   for (let i = 0; i < input.length; i += 1) {",
            "     if (input[i] !== SEPARATOR) continue;",
            "-    tokens.push(input.slice(start, i));",
            "+    if (i > start) tokens.push(input.slice(start, i));",
            "     start = i + 1;",
            "   }",
            "   return tokens;",
          ].join("\n"),
        },
      ],
    },
  ],
};
