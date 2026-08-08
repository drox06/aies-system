"use client";

import { Fragment, useState } from "react";
import { ActivityFeed } from "@/components/ActivityFeed";
import { trpc } from "@/lib/trpc/client";

export default function AdminUsersPage() {
  const utils = trpc.useUtils();
  const users = trpc.admin.listUsers.useQuery();
  const roles = trpc.admin.listRoles.useQuery();
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  const createUser = trpc.admin.createUser.useMutation({
    onSuccess: () => void utils.admin.listUsers.invalidate(),
  });
  const assignRole = trpc.admin.assignRole.useMutation({
    onSuccess: () => {
      void utils.admin.listUsers.invalidate();
      void utils.comments.activityFeed.invalidate();
    },
  });
  const removeRole = trpc.admin.removeRole.useMutation({
    onSuccess: () => {
      void utils.admin.listUsers.invalidate();
      void utils.comments.activityFeed.invalidate();
    },
  });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleKey, setRoleKey] = useState("");
  const [createdTempPassword, setCreatedTempPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreatedTempPassword(null);
    try {
      const result = await createUser.mutateAsync({ email, name, roleKey });
      setCreatedTempPassword(result.tempPassword);
      setEmail("");
      setName("");
      setRoleKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create user.");
    }
  }

  return (
    <main style={{ maxWidth: 800, margin: "3rem auto", fontFamily: "system-ui" }}>
      <h1>Users</h1>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Create user</h2>
        <form onSubmit={handleCreate} style={{ display: "flex", gap: 8, alignItems: "end" }}>
          <div>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="name">Name</label>
            <input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="roleKey">Role</label>
            <select
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
            </select>
          </div>
          <button type="submit" disabled={createUser.isPending}>
            {createUser.isPending ? "Creating..." : "Create"}
          </button>
        </form>
        {error && <p style={{ color: "#B3261E" }}>{error}</p>}
        {createdTempPassword && (
          <p>
            User created. Temporary password: <code>{createdTempPassword}</code> (share this out of
            band — it will not be shown again).
          </p>
        )}
      </section>

      <section>
        <h2>All users</h2>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={cellStyle}>Name</th>
              <th style={cellStyle}>Email</th>
              <th style={cellStyle}>Roles</th>
              <th style={cellStyle}>2FA</th>
              <th style={cellStyle}>Add role</th>
              <th style={cellStyle}>Activity</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.map((user) => (
              <Fragment key={user.id}>
                <tr>
                  <td style={cellStyle}>
                    {user.name} {user.isDemoUser && <em>(demo)</em>}
                  </td>
                  <td style={cellStyle}>{user.email}</td>
                  <td style={cellStyle}>
                    {user.roles.map((role) => (
                      <span key={role.key} style={{ marginRight: 6 }}>
                        {role.name}
                        <button
                          type="button"
                          aria-label={`Remove ${role.name} from ${user.name}`}
                          onClick={() => removeRole.mutate({ userId: user.id, roleKey: role.key })}
                          disabled={removeRole.isPending}
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                  </td>
                  <td style={cellStyle}>{user.totpEnabled ? "Enrolled" : "Not enrolled"}</td>
                  <td style={cellStyle}>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (!e.target.value) return;
                        assignRole.mutate({ userId: user.id, roleKey: e.target.value });
                        e.target.value = "";
                      }}
                    >
                      <option value="" disabled>
                        Add role...
                      </option>
                      {roles.data?.map((role) => (
                        <option key={role.key} value={role.key}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={cellStyle}>
                    <button
                      type="button"
                      onClick={() => setExpandedUserId(expandedUserId === user.id ? null : user.id)}
                    >
                      {expandedUserId === user.id ? "Hide" : "Show"}
                    </button>
                  </td>
                </tr>
                {expandedUserId === user.id && (
                  <tr>
                    <td colSpan={6} style={{ ...cellStyle, background: "#F5F7FA" }}>
                      <ActivityFeed entityType="User" entityId={user.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

const cellStyle: React.CSSProperties = {
  border: "1px solid #DCE3EB",
  padding: "4px 8px",
  textAlign: "left",
};
