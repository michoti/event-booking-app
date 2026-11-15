import Link from "next/link";
export default function NotFound() {
  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-4xl">We couldn’t find that page</h1>
      <p>The event may have ended or the link may be wrong.</p>
      <Link className="btn btn-primary" href="/">See what’s on</Link>
    </section>
  );
}
