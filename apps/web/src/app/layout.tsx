import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "diffsync", description: "Review a pull request together." };

/**
 * Dark Mode, Best practices: "Avoid offering an app-specific appearance
 * setting... they may think your app is broken because it doesn't respond to
 * their systemwide appearance choice." There is no theme switch. `color-scheme`
 * makes form controls, scrollbars and the default canvas follow the system, and
 * every colour token in globals.css has a light and a dark value.
 */
export const viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0e12" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
