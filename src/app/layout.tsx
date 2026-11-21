import type { Metadata } from "next";
import "./style.css";
export const metadata: Metadata = {
  title: "Relay Intake | Intake studio",
  description:
    "Multilingual fictional patient intake rehearsal for Hack Western 13",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
