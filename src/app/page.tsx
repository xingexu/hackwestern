import Studio from "@/ui/Studio";
export const dynamic = "force-dynamic";
export default function Page() {
  return <Studio hasKey={Boolean(process.env.GEMINI_API_KEY)} />;
}
