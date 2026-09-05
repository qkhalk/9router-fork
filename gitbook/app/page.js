import { DEFAULT_LANG } from "@/constants/languages";

// Static-friendly redirect to default language (meta refresh + client script).
// basePath comes from the build env (next.config env block): repo-subpath Pages
// deploys set NEXT_PUBLIC_BASE_PATH=/9router, and the redirect must respect
// it - a bare /en/ under a subpath hops to the domain root and 404s.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const target = `${BASE_PATH}/${DEFAULT_LANG}/`;

export const metadata = {
  title: "Redirecting...",
  other: {
    "http-equiv:refresh": `0; url=${target}`
  }
};

export default function HomePage() {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: `window.location.replace("${target}");`
        }}
      />
      <meta httpEquiv="refresh" content={`0; url=${target}`} />
      <p style={{ padding: "2rem", textAlign: "center" }}>
        Redirecting to <a href={target}>{target}</a>...
      </p>
    </>
  );
}
