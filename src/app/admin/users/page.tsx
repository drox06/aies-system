"use client";

import { Fragment, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/ui/cells";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Card, PageHeader } from "@/components/ui/layout";
import { StatusBadge } from "@/components/ui/status-badge";
import { toastError, toastSuccess } from "@/lib/errors";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

type PendingAction = { kind: "deactivate" | "delete"; userId: string; name: string } | null;

export default function AdminUsersPage() {
  const utils = trpc.useUtils();
  const users = trpc.admin.listUsers.useQuery();
  const roles = trpc.admin.listRoles.useQuery();
  const whoami = trpc.system.whoami.useQuery();

  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);

  // Every mutation refreshes the same two things, so they share one handler rather than four
  // near-identical copies that can drift apart.
  const refresh = () => {
    void utils.admin.listUsers.invalidate();
    void utils.comments.activityFeed.invalidate();
  };

  const createUser = trpc.admin.createUser.useMutation({ onSuccess: refresh });
  const assignRole = trpc.admin.assignRole.useMutation({
    onSuccess: () => {
      refresh();
      toastSuccess("Role added.");
    },
    // Previously these had no onError at all, so a rejected assignment looked identical to a
    // successful one: the dropdown reset and nothing else happened.
    onError: toastError,
  });
  const removeRole = trpc.admin.removeRole.useMutation({
    onSuccess: () => {
      refresh();
      toastSuccess("Role removed.");
    },
    onError: toastError,
  });
  const setUserActive = trpc.admin.setUserActive.useMutation({
    onSuccess: () => {
      refresh();
      setPending(null);
    },
    onError: (error) => {
      toastError(error);
      setPending(null);
    },
  });
  const deleteUser = trpc.admin.deleteUser.useMutation({
    onSuccess: () => {
      refresh();
      setPending(null);
      toastSuccess("User deleted.");
    },
    onError: (error) => {
      toastError(error);
      setPending(null);
    },
  });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleKey, setRoleKey] = useState("");
  const [createdTempPassword, setCreatedTempPassword] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreatedTempPassword(null);
    try {
      const result = await createUser.mutateAsync({ email, name, roleKey });
      setCreatedTempPassword(result.tempPassword);
      setEmail("");
      setName("");
      setRoleKey("");
    } catch (err) {
      toastError(err);
    }
  }

  const pendingUser = pending ? users.data?.find((u) => u.id === pending.userId) : undefined;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Users"
        description="Create accounts, grant roles, and deactivate people who have left."
      />

      <Card className="mb-6">
        <h2 className="mb-3 text-base">Create user</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              required
              placeholder="name@aieselectromech.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex min-w-44 flex-1 flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              required
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex min-w-44 flex-col gap-1.5">
            <Label htmlFor="roleKey">Role</Label>
            <Select
              id="roleKey"
              required
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
            >
              <option value="" disabled>
                Select a role
              </option>
              {roles.data?.map((role) => (
                <option key={role.key} value={role.key}>
                  {role.name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={createUser.isPending}>
            {createUser.isPending ? "Creating..." : "Create"}
          </Button>
        </form>

        {createdTempPassword && (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
            <p className="font-medium">User created.</p>
            <p className="mt-1">
              Temporary password:{" "}
              <code className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono">
                {createdTempPassword}
              </code>
            </p>
            <p className="mt-1 text-text-muted">
              Share this out of band — it will not be shown again. They must change it and enrol
              TOTP at first sign-in.
            </p>
            {/*
              Said here because here is where the person who needs to say it is standing. There is no
              TOTP reset in this screen and that is deliberate: an admin who can reset a second factor
              is a second factor that can be reset by whoever compromises the admin. The consequence
              lands on the new user, so the warning belongs at the moment their account is made.
            */}
            <p className="mt-2 font-medium">
              Tell them to save their recovery codes somewhere that is not the phone running the
              authenticator.
            </p>
            <p className="mt-1 text-text-muted">
              Those codes are the only way back in. Nobody here can reset a lost authenticator — a
              wiped phone with the codes on it locks that person out for good.
            </p>
          </div>
        )}
      </Card>

      <Card className="p-0">
        <h2 className="border-b border-border p-4 text-base">All users</h2>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-table">
            <thead className="bg-surface-2">
              <tr>
                {["User", "Roles", "2FA", "Status", "Add role", ""].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-3 py-2 text-left font-medium text-text-muted"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.isPending && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-text-muted">
                    Loading...
                  </td>
                </tr>
              )}
              {users.data?.map((user) => {
                const isSelf = user.id === whoami.data?.id;
                const busy =
                  (setUserActive.isPending || deleteUser.isPending) && pending?.userId === user.id;
                return (
                  <Fragment key={user.id}>
                    <tr className={cn("border-t border-border", !user.isActive && "opacity-60")}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <UserAvatar name={user.name} size={28} />
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {user.name}
                              {user.isDemoUser && (
                                <span className="ml-1 text-xs text-text-muted">(demo)</span>
                              )}
                              {isSelf && (
                                <span className="ml-1 text-xs text-text-muted">(you)</span>
                              )}
                            </p>
                            <p className="truncate text-xs text-text-muted">{user.email}</p>
                          </div>
                        </div>
                      </td>

                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {user.roles.length === 0 && (
                            <span className="text-xs text-text-muted">none</span>
                          )}
                          {user.roles.map((role) => (
                            <span
                              key={role.key}
                              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2.5 text-xs"
                            >
                              {role.name}
                              <button
                                type="button"
                                aria-label={`Remove ${role.name} from ${user.name}`}
                                onClick={() =>
                                  removeRole.mutate({ userId: user.id, roleKey: role.key })
                                }
                                disabled={removeRole.isPending}
                                className="rounded-full px-1 text-text-muted hover:bg-border hover:text-danger"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="px-3 py-2">
                        {user.totpEnabled ? (
                          <StatusBadge tone="approved">Enrolled</StatusBadge>
                        ) : (
                          <StatusBadge tone="pending">Not enrolled</StatusBadge>
                        )}
                      </td>

                      <td className="px-3 py-2">
                        {user.isActive ? (
                          <StatusBadge tone="active">Active</StatusBadge>
                        ) : (
                          <StatusBadge tone="cancelled">Disabled</StatusBadge>
                        )}
                      </td>

                      <td className="px-3 py-2">
                        <Select
                          className="h-8 w-40"
                          aria-label={`Add role to ${user.name}`}
                          // Controlled and pinned to "": this is a picker, not a display of
                          // current state, so it returns to the prompt after each choice. The
                          // roles it grants show up in the Roles column to the left.
                          value=""
                          disabled={assignRole.isPending || !user.isActive}
                          onChange={(e) => {
                            if (!e.target.value) return;
                            assignRole.mutate({ userId: user.id, roleKey: e.target.value });
                          }}
                        >
                          <option value="">Add role...</option>
                          {roles.data
                            ?.filter((role) => !user.roles.some((r) => r.key === role.key))
                            .map((role) => (
                              <option key={role.key} value={role.key}>
                                {role.name}
                              </option>
                            ))}
                        </Select>
                      </td>

                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setExpandedUserId(expandedUserId === user.id ? null : user.id)
                            }
                          >
                            {expandedUserId === user.id ? "Hide" : "Activity"}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={isSelf || busy}
                            title={isSelf ? "You cannot disable your own account" : undefined}
                            onClick={() => {
                              if (user.isActive) {
                                setPending({
                                  kind: "deactivate",
                                  userId: user.id,
                                  name: user.name,
                                });
                              } else {
                                // Re-enabling is reversible and low-risk, so it needs no dialog.
                                setPending({
                                  kind: "deactivate",
                                  userId: user.id,
                                  name: user.name,
                                });
                                setUserActive.mutate({ userId: user.id, isActive: true });
                              }
                            }}
                          >
                            {user.isActive ? "Disable" : "Enable"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isSelf || busy}
                            title={isSelf ? "You cannot delete your own account" : undefined}
                            className="text-danger hover:bg-danger/10"
                            onClick={() =>
                              setPending({ kind: "delete", userId: user.id, name: user.name })
                            }
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>

                    {expandedUserId === user.id && (
                      <tr className="border-t border-border bg-bg">
                        <td colSpan={6} className="p-4">
                          <ActivityFeed entityType="User" entityId={user.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <ConfirmDialog
        open={pending?.kind === "deactivate" && pendingUser?.isActive === true}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Disable ${pending?.name ?? ""}?`}
        description="They will be signed out on their next request and cannot sign in again until re-enabled. Their history, approvals and comments are kept."
        confirmLabel="Disable"
        isPending={setUserActive.isPending}
        onConfirm={() => {
          if (pending) setUserActive.mutate({ userId: pending.userId, isActive: false });
        }}
      />

      <ConfirmDialog
        open={pending?.kind === "delete"}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Delete ${pending?.name ?? ""}?`}
        description="This is a soft delete: the account is removed from this list and can never sign in again, but its audit history stays intact because approvals and comments reference it. Prefer Disable unless the account was created in error."
        confirmLabel="Delete user"
        destructive
        // Spec.md §6.3's worry is a reflexive second click on something irreversible. Typing the
        // name makes this an actual decision.
        confirmPhrase={pending?.name}
        isPending={deleteUser.isPending}
        onConfirm={() => {
          if (pending) deleteUser.mutate({ userId: pending.userId });
        }}
      />
    </div>
  );
}
