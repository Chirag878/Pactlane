import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import {
  ROLE_LABELS,
  WorkspaceSwitcher,
} from "@/components/organizations/WorkspaceSwitcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export function meta() {
  return [{ title: "Members - Pactlane" }];
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export default function OrganizationMembersRoute() {
  const { organizationId = "" } = useParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, error } = useActionQuery(
    "list-organization-members",
    { organizationId },
  );
  const onError = (fallback: string) => (err: unknown) =>
    toast.error(actionErrorMessage(err) ?? fallback);

  const invite = useActionMutation("invite-organization-member", {
    uiOnly: true,
    onSuccess: (result) => {
      setEmail("");
      setRole("member");
      setCopied(false);
      setLink({
        email: result.invitation.email,
        url: new URL(result.acceptPath, window.location.origin).toString(),
      });
    },
    onError: onError("Could not create the invitation."),
  });
  const revoke = useActionMutation("revoke-organization-invitation", {
    uiOnly: true,
    onSuccess: (result) =>
      result.changed
        ? toast.success("Invitation revoked.")
        : toast.info("That invitation was no longer pending."),
    onError: onError("Could not revoke the invitation."),
  });
  const remove = useActionMutation("remove-organization-member", {
    uiOnly: true,
    onError: onError("Could not remove the member."),
  });
  const transfer = useActionMutation("transfer-organization-ownership", {
    uiOnly: true,
    onSuccess: () => toast.success("Ownership transferred."),
    onError: onError("Could not transfer ownership."),
  });
  const busy =
    invite.isPending ||
    revoke.isPending ||
    remove.isPending ||
    transfer.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    invite.mutate({ organizationId, email, role });
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      toast.error("Copy failed. Select the link and copy it manually.");
    }
  }

  function removeMember(target: string, isYou: boolean) {
    const question = isYou
      ? "Leave this organization? You will lose access to its projects until someone invites you again."
      : `Remove ${target}? They lose access to this organization's projects at once. Their past work is kept.`;
    if (!window.confirm(question)) return;
    remove.mutate(
      { organizationId, email: target },
      {
        onSuccess: () => {
          if (isYou) void navigate("/organizations");
          else toast.success(`Removed ${target}.`);
        },
      },
    );
  }

  function makeOwner(target: string) {
    if (
      !window.confirm(
        `Make ${target} the owner? You will become an admin and cannot undo this yourself.`,
      )
    ) {
      return;
    }
    transfer.mutate({ organizationId, newOwnerEmail: target });
  }

  const header = (
    <header className="flex flex-col gap-3">
      <WorkspaceSwitcher
        current={{ kind: "organization", id: organizationId }}
      />
      <Link
        to={`/organizations/${organizationId}`}
        className="text-sm text-muted-foreground hover:underline"
      >
        Back to organization
      </Link>
      <h1 className="text-xl font-semibold">Members</h1>
    </header>
  );

  if (error) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
        {header}
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ?? "Could not load members."}
        </p>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
        {header}
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const isOwner = data.you.role === "owner";
  const canInvite = isOwner || data.you.role === "admin";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-4 sm:p-6">
      {header}

      <section
        aria-labelledby="members-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="members-heading" className="text-base font-semibold">
          {data.members.length}{" "}
          {data.members.length === 1 ? "member" : "members"}
        </h2>
        <ul className="flex flex-col divide-y divide-border rounded-xl border">
          {data.members.map((member) => (
            <li
              key={member.email}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {member.email}
                  {member.isYou ? (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      (you)
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  Joined {formatDate(member.joinedAt)}
                </p>
              </div>
              <Badge
                variant={member.role === "owner" ? "secondary" : "outline"}
              >
                {ROLE_LABELS[member.role]}
              </Badge>
              {isOwner && !member.isYou ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => makeOwner(member.email)}
                >
                  Make owner
                </Button>
              ) : null}
              {member.canRemove ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => removeMember(member.email, member.isYou)}
                >
                  {member.isYou ? "Leave" : "Remove"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {isOwner ? (
          <p className="text-xs text-muted-foreground">
            As the owner you cannot leave or be removed until you make another
            member the owner.
          </p>
        ) : null}
      </section>

      {canInvite ? (
        <section
          aria-labelledby="invite-heading"
          className="flex flex-col gap-4 rounded-xl border p-4 sm:p-5"
        >
          <div className="flex flex-col gap-1">
            <h2 id="invite-heading" className="text-base font-semibold">
              Invite someone
            </h2>
            <p className="text-sm text-muted-foreground">
              No email is sent. Copy the link and give it to them. Only the
              invited address can accept it, after signing in with a verified
              email. It expires in 7 days and works once.
            </p>
          </div>
          <form
            onSubmit={submit}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={320}
                required
              />
            </div>
            {isOwner ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <select
                  id="invite-role"
                  value={role}
                  onChange={(event) =>
                    setRole(event.target.value as "member" | "admin")
                  }
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            ) : null}
            <Button type="submit" disabled={busy || email.trim().length === 0}>
              {invite.isPending ? "Creating…" : "Create invitation"}
            </Button>
          </form>

          {link ? (
            <div
              role="status"
              className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/[0.04] p-3"
            >
              <p className="text-sm font-medium">
                Invitation link for {link.email}
              </p>
              <p className="text-xs text-muted-foreground">
                Copy it now. For security it is not stored and will not be shown
                again; revoke and re-invite to get a new one.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  readOnly
                  value={link.url}
                  aria-label="Invitation link"
                  onFocus={(event) => event.currentTarget.select()}
                  className="font-mono text-xs"
                />
                <Button type="button" variant="outline" onClick={copyLink}>
                  {copied ? (
                    <IconCheck className="size-4" />
                  ) : (
                    <IconCopy className="size-4" />
                  )}
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Pending invitations</h3>
            {data.invitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {data.invitations.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{invitation.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {ROLE_LABELS[invitation.role]} · invited by{" "}
                        {invitation.invitedBy} ·{" "}
                        {invitation.expired
                          ? "expired"
                          : `expires ${formatDate(invitation.expiresAt)}`}
                      </p>
                    </div>
                    {invitation.expired ? (
                      <Badge variant="outline">Expired</Badge>
                    ) : null}
                    {invitation.canRevoke ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          revoke.mutate({ invitationId: invitation.id })
                        }
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
