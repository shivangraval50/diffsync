import type { ReactNode } from "react";

export const metadata = { title: "diffsync", description: "Review a pull request together." };

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
