import { redirect } from "next/navigation";

// Post-signup landing. Onboarding happens in the /app chat (ChatPanel starts it
// automatically when no user_profile memory exists), so this is just a redirect.
export default function OnboardingPage() {
  redirect("/app");
}
