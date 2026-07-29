import type { JSX } from 'react';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MediWork — 근무표',
  description: '의료기관 전용 근태·인사 관리',
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
