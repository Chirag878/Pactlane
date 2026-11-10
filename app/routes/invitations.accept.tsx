import {
  actionErrorMessage,
  useActionMutation,
} from "@agent-native/core/client/hooks";
import { IconBuilding } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";

export function meta() {
  return [{ title: "Accept invitation - Pactlane" }];
}

/**
 * The token travels in the URL fragment, which browsers never send to the
 * server. It is read once, then removed from the address bar and history.
 */
export default function AcceptInvitationRoute() {
  const navigate = useNavigate();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const accept = useActionMutation("accept-organization-invitation", {
    uiOnly: true,
    onSuccess: (result) =>
      void navigate(`/organizations/${result.organization.id}`, {
        replace: true,
      }),
  });

  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get(
      "token",
    );
    setToken(value && value.length >= 20 ? value : null);
    if (window.location.hash) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname,
      );
    }
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 p-4 pt-12 sm:p-6 sm:pt-16">
      <IconBuilding
        className="size-8 text-muted-foreground"
        strokeWidth={1.5}
      />
      <h1 className="text-xl font-semibold">Organization invitation</h1>
      {token === undefined ? (
        <p className="text-sm text-muted-foreground">Reading the link…</p>
      ) : token === null ? (
        <p role="alert" className="text-sm text-destructive">
          This link has no invitation in it. Open the full link you were given,
          or ask for a new one.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Accepting adds you to the organization. You will see only the
            projects people share with you. The invitation works for the email
            address it was sent to, once you have verified it.
          </p>
          {accept.error ? (
            <p role="alert" className="text-sm text-destructive">
              {actionErrorMessage(accept.error) ??
                "This invitation could not be accepted."}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              onClick={() => accept.mutate({ token })}
              disabled={accept.isPending}
            >
              {accept.isPending ? "Accepting…" : "Accept invitation"}
            </Button>
            <Button asChild variant="ghost">
              <Link to="/projects">Not now</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
