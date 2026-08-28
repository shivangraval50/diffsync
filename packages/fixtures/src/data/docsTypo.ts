import type { Fixture } from "../types.js";

export const docsTypo: Fixture = {
  slug: "docs-typo",
  title: "Fix a typo in the deployment guide",
  author: "octo-reviewer",
  blurb: "A one-line change, plus a binary asset with no patch.",
  revisions: [
    {
      headSha: "abcdef0123456789abcdef0123456789abcdef01",
      baseSha: "9876543210fedcba9876543210fedcba98765432",
      files: [
        {
          path: "docs/deploy.md",
          previousPath: null,
          blobSha: "blob-deploy-r1",
          status: "modified",
          patch: [
            "@@ -7,3 +7,3 @@ ## Deploying",
            " Run the migration first.",
            "-Then deploy the wroker.",
            "+Then deploy the worker.",
            " Confirm the health check passes.",
          ].join("\n"),
        },
        {
          path: "docs/architecture.png",
          previousPath: null,
          blobSha: "blob-architecture-r1",
          status: "modified",
          // No patch: a binary file. Present so the renderer's "omitted" path
          // and `toAnchorTarget`'s empty-target rule are exercised by a real
          // fixture, not only by a unit test.
          patch: "",
        },
      ],
    },
  ],
};
