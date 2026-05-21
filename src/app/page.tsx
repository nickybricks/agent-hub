import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { Hero } from "@/components/landing/Hero";

export const dynamic = "force-dynamic";

export default async function Landing() {
  const user = await getAuthUser();
  if (user) redirect("/app");
  return <Hero />;
}
