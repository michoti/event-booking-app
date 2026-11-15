import Link from "next/link";
import { services } from "@/lib/server";
import { money, when } from "@/lib/format";
import { AvailabilityMeter } from "@/components/AvailabilityMeter";
import { DegradedBanner } from "@/components/DegradedBanner";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const s = await services().catch(() => null);
  // Even with no database at all, the page renders the bundled listing.
  const listing = s ? await s.events.list(100) : { events: (await import("@/lib/fallback/events")).FALLBACK_EVENTS, source: "fallback" as const };
  let events = listing.events;
  if (q && s && listing.source === "live") {
    const { results } = await s.search.search(q, 20);
    const rank = new Map(results.map((r, i) => [r.slug, i]));
    events = events.filter((e) => rank.has(e.slug)).sort((a, b) => rank.get(a.slug)! - rank.get(b.slug)!);
  }

  return (
    <>
      <DegradedBanner source={listing.source} />
      <h1 className="max-w-2xl text-4xl leading-tight sm:text-5xl">{q ? `Results for “${q}”` : "What’s on in Nairobi this month"}</h1>
      <p className="mt-3 max-w-xl">Conferences, summits and meetups. Hold your seats for ten minutes, pay, and walk in.</p>

      <ul className="mt-8 space-y-5" aria-label="Events">
        {events.length === 0 && <li className="ui">No events match. Try a different search.</li>}
        {events.map((e) => {
          const bookable = !e.id.startsWith("fallback");
          return (
            <li key={e.id} className="stub-card flex flex-col sm:flex-row">
              <div className="flex-1 p-5">
                <h2 className="text-2xl">
                  {bookable ? <Link href={`/events/${e.slug}`} className="underline-offset-4 hover:underline">{e.title}</Link> : e.title}
                </h2>
                <p className="ui mt-1 text-sm">{when(e.startsAt, e.timezone)}</p>
                <p className="ui text-sm">{e.venueName}, {e.city}</p>
              </div>
              <div className="perforation w-full p-5 sm:w-[8.5rem]">
                {e.minPriceCents !== null && e.currency ? (
                  <>
                    <p className="ui text-sm">From</p>
                    <p className="ui text-lg font-semibold">{money(e.minPriceCents, e.currency)}</p>
                    <div className="mt-2"><AvailabilityMeter available={e.seatsLeft} total={e.capacity} /></div>
                  </>
                ) : (
                  <p className="ui text-sm">Pricing unavailable</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
