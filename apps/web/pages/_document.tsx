import { platform } from "@todesktop/client-core";
import type { IncomingMessage } from "node:http";
import { dir } from "i18next";
import type { DocumentContext, DocumentProps } from "next/document";
import Document, { Head, Html, Main, NextScript } from "next/document";

import { IS_PRODUCTION } from "@calcom/lib/constants";

import { applyTheme, applyToDesktopClass } from "./../lib/pages/document/_applyThemeForDocument";

type Props = Record<string, unknown> & DocumentProps & { newLocale: string };

class MyDocument extends Document<Props> {
  static async getInitialProps(ctx: DocumentContext) {
    const getLocaleModule = ctx.req ? await import("@calcom/features/auth/lib/getLocale") : null;

    const newLocale =
      ctx.req && getLocaleModule
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await getLocaleModule.getLocale(ctx.req as IncomingMessage & { cookies: Record<string, any> })
        : "en";

    const asPath = ctx.asPath || "";
    // Use a dummy URL as default so that URL parsing works for relative URLs as well. We care about searchParams and pathname only
    const parsedUrl = new URL(asPath, "https://dummyurl");
    const isEmbedSnippetGeneratorPath = parsedUrl.pathname.startsWith("/event-types");
    // FIXME: Revisit this logic to remove embedType query param check completely. Ideally, /embed should always be there at the end of the URL. Test properly and then remove it.
    const isEmbed =
      (parsedUrl.pathname.endsWith("/embed") || parsedUrl.searchParams.get("embedType") !== null) &&
      !isEmbedSnippetGeneratorPath;
    const embedColorScheme = parsedUrl.searchParams.get("ui.color-scheme");
    const initialProps = await Document.getInitialProps(ctx);
    return { isEmbed, embedColorScheme, ...initialProps, newLocale };
  }

  render() {
    const { isEmbed, embedColorScheme } = this.props;
    const newLocale = this.props.newLocale || "en";
    const newDir = dir(newLocale);

    const isDesktopApp = (() => {
      try {
        return platform.todesktop.isDesktopApp();
      } catch {
        return false;
      }
    })();

    return (
      <Html
        className="dark"
        lang={newLocale}
        dir={newDir}
        style={embedColorScheme ? { colorScheme: embedColorScheme as string } : { colorScheme: "dark" }}>
        <Head>
          <script
            id="newLocale"
            // eslint-disable-next-line react/no-danger
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Setting locale and theme requires inline script
            dangerouslySetInnerHTML={{
              __html: `
              window.calNewLocale = "${newLocale}";
              window.calIsDesktopApp = ${isDesktopApp};
              (${applyTheme.toString()})();
              (${applyToDesktopClass.toString()})();
            `,
            }}
          />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
          <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
          <link rel="shortcut icon" href="/favicon.ico" />
          <link rel="manifest" href="/site.webmanifest" />
          <meta name="msapplication-TileColor" content="#000000" />
          <meta name="theme-color" content="#000000" />
          {!IS_PRODUCTION && process.env.VERCEL_ENV === "preview" && (
            // eslint-disable-next-line @next/next/no-sync-scripts
            <script
              data-project-id="KjpMrKTnXquJVKfeqmjdTffVPf1a6Unw2LZ58iE4"
              src="https://snippet.meticulous.ai/v1/stagingMeticulousSnippet.js"
            />
          )}
        </Head>

        <body
          className="dark:bg-default bg-subtle antialiased"
          style={
            isEmbed
              ? {
                  background: "transparent",
                  // Keep the embed hidden till parent initializes and
                  // - gives it the appropriate styles if UI instruction is there.
                  // - gives iframe the appropriate height(equal to document height) which can only be known after loading the page once in browser.
                  // - Tells iframe which mode it should be in (dark/light) - if there is a a UI instruction for that
                  visibility: "hidden",
                }
              : {}
          }>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
