'use client';
import { ReactNode } from 'react';
import './globals.css';
import StyledJsxRegistry from './registry';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang='en'>
      <head />
      <body>
        <StyledJsxRegistry>{children}</StyledJsxRegistry>
      </body>
    </html>
  );
}
