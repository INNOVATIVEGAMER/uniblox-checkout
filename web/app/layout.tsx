import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import { ResponsePanel } from '@/components/response-panel';
import { Providers } from './providers';
import './globals.css';

const geistSans = Geist({ variable: '--font-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Uniblox Checkout Demo',
  description: 'A thin client that drives the checkout API and shows every response',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body className="min-h-screen bg-background text-foreground">
        <Providers>
          <header className="border-b">
            <nav className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3 text-sm">
              <span className="font-semibold">Uniblox Checkout</span>
              <Link href="/" className="hover:underline">
                Shop
              </Link>
              <Link href="/admin" className="hover:underline">
                Admin
              </Link>
            </nav>
          </header>
          <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_400px]">
            <main className="min-w-0">{children}</main>
            <aside>
              <ResponsePanel />
            </aside>
          </div>
        </Providers>
      </body>
    </html>
  );
}
