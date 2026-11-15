import type { Metadata } from "next";
import Link from "next/link";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/roboto-flex";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "./globals.css";
import { safeAuth } from "@/auth";

export const metadata: Metadata = { title: "Event Booking", description: "Find a professional event near you and walk in with a valid ticket." };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await safeAuth();
  return (
    <html lang="en">
      <body className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:m-2 focus:rounded focus:bg-white focus:p-2">Skip to content</a>
        <header className="border-b border-slate-200">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3" aria-label="Main">
            <Link href="/" className="font-display text-xl font-semibold">Event Booking</Link>
            <form action="/" method="get" role="search" className="ml-auto flex min-w-0 flex-1 gap-2 sm:max-w-sm">
              <label className="sr-only" htmlFor="q">Search events</label>
              <input id="q" name="q" type="search" maxLength={200} placeholder="Search events" className="min-h-[44px] w-full min-w-0 rounded-lg border border-slate-400 px-3" />
              <button className="btn btn-secondary" type="submit">Search</button>
            </form>
            {session?.user ? (
              <span className="ui text-sm">{session.user.name ?? session.user.email}</span>
            ) : (
              <Link href="/signin" className="btn btn-secondary">Sign in</Link>
            )}
          </nav>
        </header>
        <main id="main" className="mx-auto max-w-5xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
