// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSharingDialog } from "./WorkspaceSharingDialog.tsx";
import {
  addWorkspaceMember,
  getWorkspaceSharing,
  removeWorkspaceMember,
  updateWorkspaceLinkAccess,
  updateWorkspaceMemberRole,
  type WorkspaceMember,
  type WorkspaceSharingSettings,
} from "./workspaceApi.ts";

vi.mock("./workspaceApi.ts", () => ({
  addWorkspaceMember: vi.fn(),
  getWorkspaceSharing: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  updateWorkspaceLinkAccess: vi.fn(),
  updateWorkspaceMemberRole: vi.fn(),
}));

const getSharingMock = vi.mocked(getWorkspaceSharing);
const addMemberMock = vi.mocked(addWorkspaceMember);
const removeMemberMock = vi.mocked(removeWorkspaceMember);
const updateLinkMock = vi.mocked(updateWorkspaceLinkAccess);
const updateRoleMock = vi.mocked(updateWorkspaceMemberRole);

function member(email = "member@example.com", role: WorkspaceMember["role"] = "viewer"): WorkspaceMember {
  return { email, role, display_name: "Member", added_at: "2026-07-16T00:00:00Z" };
}

function settings(overrides: Partial<WorkspaceSharingSettings> = {}): WorkspaceSharingSettings {
  return {
    link_access: "restricted",
    link_role: "viewer",
    members: [member()],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("WorkspaceSharingDialog", () => {
  it("announces a load failure and retries without closing the dialog", async () => {
    getSharingMock
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(settings());
    render(<WorkspaceSharingDialog workspaceId="workspace-1" open onClose={() => {}} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Could not load sharing settings.")).toBeTruthy();
    expect(screen.getByText("network unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(getSharingMock).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("status")).textContent).toContain("Sharing settings loaded.");
    expect(screen.getByText("member@example.com")).toBeTruthy();
  });

  it("lets a user dismiss an unrecoverable load failure by closing the dialog", async () => {
    getSharingMock.mockRejectedValue(new Error("permission lookup failed"));
    const onClose = vi.fn();
    render(<WorkspaceSharingDialog workspaceId="workspace-1" open onClose={onClose} />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest workspace load when an older request resolves late", async () => {
    const oldLoad = deferred<WorkspaceSharingSettings>();
    getSharingMock
      .mockReturnValueOnce(oldLoad.promise)
      .mockResolvedValueOnce(settings({ members: [member("new@example.com")] }));
    const { rerender } = render(
      <WorkspaceSharingDialog workspaceId="old" open onClose={() => {}} />,
    );
    rerender(<WorkspaceSharingDialog workspaceId="new" open onClose={() => {}} />);

    expect(await screen.findByText("new@example.com")).toBeTruthy();
    await act(async () => oldLoad.resolve(settings({ members: [member("old@example.com")] })));
    expect(screen.queryByText("old@example.com")).toBeNull();
    expect(screen.getByText("new@example.com")).toBeTruthy();
  });

  it("makes mutation failure retryable and announces eventual success", async () => {
    getSharingMock.mockResolvedValue(settings());
    updateLinkMock
      .mockRejectedValueOnce(new Error("write conflict"))
      .mockResolvedValueOnce(settings({ link_access: "anyone_with_link" }));
    render(<WorkspaceSharingDialog workspaceId="workspace-1" open onClose={() => {}} />);
    const access = await screen.findByLabelText("Link access");

    fireEvent.change(access, { target: { value: "anyone_with_link" } });
    expect((await screen.findByRole("alert")).textContent).toContain("Could not update link access.");
    expect(screen.getByText("write conflict")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(updateLinkMock).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("status")).textContent).toContain("Link access updated.");
    expect((screen.getByLabelText("Link access") as HTMLSelectElement).value).toBe("anyone_with_link");
  });

  it("merges concurrent link and member successes without either overwriting the other", async () => {
    const link = deferred<WorkspaceSharingSettings>();
    const role = deferred<WorkspaceMember>();
    getSharingMock.mockResolvedValue(settings());
    updateLinkMock.mockReturnValue(link.promise);
    updateRoleMock.mockReturnValue(role.promise);
    render(<WorkspaceSharingDialog workspaceId="workspace-1" open onClose={() => {}} />);
    const access = await screen.findByLabelText("Link access");
    const memberRole = screen.getAllByRole("combobox").at(-1)!;

    // Dispatch in one React batch to model two already-queued browser events.
    act(() => {
      fireEvent.change(access, { target: { value: "anyone_with_link" } });
      fireEvent.change(memberRole, { target: { value: "editor" } });
    });
    expect(updateLinkMock).toHaveBeenCalledTimes(1);
    expect(updateRoleMock).toHaveBeenCalledTimes(1);

    await act(async () => role.resolve(member("member@example.com", "editor")));
    expect(screen.getAllByRole("combobox").at(-1)).toHaveProperty("value", "editor");
    await act(async () => link.resolve(settings({
      link_access: "anyone_with_link",
      members: [member("member@example.com", "viewer")],
    })));

    expect(screen.getAllByRole("combobox").at(-1)).toHaveProperty("value", "editor");
    expect((screen.getByLabelText("Link access") as HTMLSelectElement).value).toBe("anyone_with_link");
    expect(screen.getByRole("status").textContent).toContain("Updated member@example.com.");
  });

  it("keeps an older link-access failure visible after a concurrent member edit", async () => {
    const link = deferred<WorkspaceSharingSettings>();
    const role = deferred<WorkspaceMember>();
    getSharingMock.mockResolvedValue(settings());
    updateLinkMock.mockReturnValue(link.promise);
    updateRoleMock.mockReturnValue(role.promise);
    render(<WorkspaceSharingDialog workspaceId="workspace-1" open onClose={() => {}} />);
    const access = await screen.findByLabelText("Link access");
    const memberRole = screen.getAllByRole("combobox").at(-1)!;

    fireEvent.change(access, { target: { value: "anyone_with_link" } });
    fireEvent.change(memberRole, { target: { value: "editor" } });
    await act(async () => role.resolve(member("member@example.com", "editor")));
    await act(async () => link.reject(new Error("link policy conflict")));

    expect(screen.getByRole("alert").textContent).toContain("Could not update link access.");
    expect(screen.getByRole("alert").textContent).toContain("link policy conflict");
    expect(screen.getAllByRole("combobox").at(-1)).toHaveProperty("value", "editor");
  });

  it("blocks duplicate add submissions while preserving a visible pending state", async () => {
    const add = deferred<WorkspaceMember>();
    getSharingMock.mockResolvedValue(settings({ members: [] }));
    addMemberMock.mockReturnValue(add.promise);
    render(<WorkspaceSharingDialog workspaceId="workspace-1" open onClose={() => {}} />);
    const email = await screen.findByPlaceholderText("person@example.com");
    fireEvent.change(email, { target: { value: "new@example.com" } });
    const addButton = screen.getByRole("button", { name: "Add" });
    fireEvent.click(addButton);
    fireEvent.click(addButton);

    expect(addMemberMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("Adding new@example.com");
    expect(addButton).toHaveProperty("disabled", true);

    await act(async () => add.resolve(member("new@example.com")));
    expect(screen.getByRole("status").textContent).toContain("Added new@example.com.");
  });

  it("cancels the visible lifecycle when closed during a request", async () => {
    const load = deferred<WorkspaceSharingSettings>();
    getSharingMock.mockReturnValue(load.promise);
    function Controlled() {
      const [open, setOpen] = useState(true);
      return (
        <WorkspaceSharingDialog
          workspaceId="workspace-1"
          open={open}
          onClose={() => setOpen(false)}
        />
      );
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => load.resolve(settings()));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("wires member role and removal mutations through the same state contract", async () => {
    getSharingMock.mockResolvedValue(settings());
    updateRoleMock.mockResolvedValue(member("member@example.com", "editor"));
    removeMemberMock.mockResolvedValue(undefined);
    render(<WorkspaceSharingDialog workspaceId="workspace-1" open onClose={() => {}} />);
    await screen.findByText("member@example.com");
    expect(screen.getByLabelText("Role for new member")).toBeTruthy();
    const roleSelect = screen.getByLabelText("Role for member@example.com");
    fireEvent.change(roleSelect, { target: { value: "editor" } });
    expect((await screen.findByRole("status")).textContent).toContain("Updated member@example.com.");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect((await screen.findByRole("status")).textContent).toContain("Removed member@example.com.");
  });
});
