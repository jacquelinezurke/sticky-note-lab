import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3003";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const socialImage = `${protocol}://${host}/og.png`;

  return {
    title: "Sticky Note Lab – Board-Fotos digitalisieren",
    description: "Lokales Experiment: Haftnotiz-Boards aus Fotos erkennen, bearbeiten und verbinden.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Sticky Note Lab",
      description: "Vom Foto zum editierbaren Board",
      images: [{ url: socialImage, width: 1536, height: 896, alt: "Sticky Note Lab: physisches Board wird zum editierbaren Canvas" }],
    },
    twitter: { card: "summary_large_image", title: "Sticky Note Lab", description: "Vom Foto zum editierbaren Board", images: [socialImage] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
