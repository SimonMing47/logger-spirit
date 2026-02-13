import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Logger Spirit",
  description: "纯前端日志解压、跨文件搜索与问题分析工作台",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
