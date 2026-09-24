/**
 * The feed page renders the gate and nothing else.
 *
 * It deliberately does NOT read the feed server-side. Passing the data as a
 * prop puts it in the page payload, where a signed-out visitor can read it
 * straight out of the HTML — which is exactly what the first version did. The
 * data is fetched from /api/feed after sign-in, with a token.
 */
import { Gate } from "../../../components/Gate";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Gate />;
}
