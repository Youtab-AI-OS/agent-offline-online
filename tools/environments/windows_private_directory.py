"""Pinned owner-only Windows staging directories for plaintext secrets."""

import os
import re
import stat
import uuid
from pathlib import Path


def _check_namespace(path: Path) -> None:
    for component in (*reversed(path.parents), path):
        if component.lstat().st_file_attributes & 0x400:
            raise PermissionError("Private directory namespace must not contain reparse points")


def _remove_owned_children(directory: Path, root: Path) -> None:
    for child in directory.iterdir():
        info = child.lstat()
        if info.st_file_attributes & 0x400 or stat.S_ISLNK(info.st_mode):
            # Delete the link itself; never walk a junction or symbolic link.
            child.rmdir() if info.st_file_attributes & 0x10 else child.unlink()
            continue
        if not child.resolve(strict=True).is_relative_to(root):
            raise PermissionError("Private directory cleanup escaped its owned namespace")
        if stat.S_ISDIR(info.st_mode):
            _remove_owned_children(child, root)
            child.rmdir()
        else:
            child.unlink()


class WindowsPrivateDirectory:
    """Create and verify a private directory before callers stage any bytes.

    A retained handle denies deletion/rename of the directory and its NTFS
    ancestors. Its inheritable DACL restricts every newly created child to the
    current token SID. Native imports are lazy; POSIX callers use their normal
    temporary-directory implementation.
    """

    def __init__(self, parent: Path, prefix: str = "youtab-"):
        if os.name != "nt":
            raise OSError("Private Windows directories require native Windows")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", prefix):
            raise ValueError("Private directory prefix must be a single safe name")
        import win32api
        import win32con
        import ntsecuritycon
        import win32file
        import win32security

        self._handle = None
        parent = Path(parent).resolve(strict=True)
        _check_namespace(parent)
        self.path = parent / f"{prefix}{uuid.uuid4().hex}"
        token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try:
            owner = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        finally:
            token.Close()
        self._owner_sid = win32security.ConvertSidToStringSid(owner)
        acl = win32security.ACL()
        # OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE protects children at creation.
        acl.AddAccessAllowedAceEx(win32security.ACL_REVISION, 3, ntsecuritycon.FILE_ALL_ACCESS, owner)
        descriptor = win32security.SECURITY_DESCRIPTOR()
        descriptor.SetSecurityDescriptorOwner(owner, False)
        descriptor.SetSecurityDescriptorDacl(True, acl, False)
        descriptor.SetSecurityDescriptorControl(win32security.SE_DACL_PROTECTED, win32security.SE_DACL_PROTECTED)
        attributes = win32security.SECURITY_ATTRIBUTES()
        attributes.SECURITY_DESCRIPTOR = descriptor
        # Do not adopt a preexisting namespace, including on a name collision.
        win32file.CreateDirectory(str(self.path), attributes)
        try:
            self._handle = win32file.CreateFile(
                str(self.path), win32con.GENERIC_READ | win32con.READ_CONTROL,
                win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE, None,
                win32con.OPEN_EXISTING, win32con.FILE_FLAG_BACKUP_SEMANTICS | 0x00200000, None,
            )
            self._verify()
        except BaseException:
            if self._handle is not None:
                self._handle.Close()
                self._handle = None
            try:
                self.path.rmdir()  # only the newly created, still-empty directory
            except OSError:
                pass
            raise

    def _verify(self) -> None:
        import win32con
        import ntsecuritycon
        import win32file
        import win32security

        actual = win32file.GetFinalPathNameByHandle(self._handle, 0)
        if actual.startswith("\\\\?\\UNC\\"):
            actual = "\\\\" + actual[8:]
        elif actual.startswith("\\\\?\\"):
            actual = actual[4:]
        if os.path.normcase(actual) != os.path.normcase(str(self.path)):
            raise PermissionError("Private directory handle has an unexpected path")
        if win32file.GetFileInformationByHandle(self._handle)[0] & 0x400:
            raise PermissionError("Private directory must not be a reparse point")
        _check_namespace(self.path)
        descriptor = win32security.GetSecurityInfo(
            self._handle, win32security.SE_FILE_OBJECT,
            win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION,
        )
        if win32security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner()) != self._owner_sid:
            raise PermissionError("Private directory has an unexpected owner")
        acl = descriptor.GetSecurityDescriptorDacl()
        control, _ = descriptor.GetSecurityDescriptorControl()
        if acl is None or not control & win32security.SE_DACL_PROTECTED or acl.GetAceCount() != 1:
            raise PermissionError("Private directory must have a protected owner-only DACL")
        ace = acl.GetAce(0)
        if (
            ace[0] != (win32security.ACCESS_ALLOWED_ACE_TYPE, 3)
            or ace[1] != ntsecuritycon.FILE_ALL_ACCESS
            or win32security.ConvertSidToStringSid(ace[2]) != self._owner_sid
        ):
            raise PermissionError("Private directory owner-only inheritance could not be verified")

    def close(self) -> None:
        if self._handle is None:
            return
        try:
            self._verify()
            _remove_owned_children(self.path, self.path)
        finally:
            self._handle.Close()
            self._handle = None
        self.path.rmdir()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.close()
