import type { Metadata } from "next";
import { STIX_Two_Text, IBM_Plex_Sans, IBM_Plex_Mono, Noto_Sans } from "next/font/google";

import "./globals.css";
import { cn } from "@/lib/utils";
import { QueryProvider } from "@/providers/QueryProvider";
import { ThemeProvider } from "@/context/ThemeContext";

const stixTwoText = STIX_Two_Text({
  variable: "--font-stix-two-text",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-ibm-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const notoSans = Noto_Sans({
  variable: "--font-noto-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Robin Wiki",
  description: "Your personal knowledge base",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn(
        "h-full",
        stixTwoText.variable,
        ibmPlexSans.variable,
        ibmPlexMono.variable,
        notoSans.variable,
        "font-sans",
      )}
      suppressHydrationWarning
    >
      <body className="h-full">
        <ThemeProvider>
          <QueryProvider>{children}</QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
