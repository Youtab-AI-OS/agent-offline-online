"""Host-independent proposal checks; mocked Darwin ABI is not Mac execution."""
import os
from pathlib import Path
import stat
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from agent import file_safety as safety


class DarwinAdapterContract(unittest.TestCase):
    def test_getpath_uses_full_kernel_buffer_and_filesystem_decoding(self):
        value = '/owned/non-ascii-β'.encode('utf-8')
        query = Mock(return_value=value + b'\0' * (1024 - len(value)))
        with patch.dict(sys.modules, {'fcntl': SimpleNamespace(fcntl=query)}):
            self.assertEqual(safety._darwin_descriptor_path(7), os.fsdecode(value))
        query.assert_called_once_with(7, 50, b'\0' * 1024)

    def test_getpath_errors_and_invalid_kernel_results_fail_closed(self):
        for result in (b'', b'\0' * 1024, b'relative\0', b'/' * 1024):
            with self.subTest(result=result[:15]), patch.dict(sys.modules, {'fcntl': SimpleNamespace(fcntl=Mock(return_value=result))}):
                with self.assertRaises(OSError):
                    safety._darwin_descriptor_path(7)
        with patch.dict(sys.modules, {'fcntl': SimpleNamespace(fcntl=Mock(side_effect=OSError('kernel refusal')))}):
            with self.assertRaisesRegex(OSError, 'kernel refusal'):
                safety._darwin_descriptor_path(7)

    def test_parent_path_move_is_refused_without_consulting_procfs(self):
        guard = object.__new__(safety.MutationParentGuard)
        prefix = Path('/owned/parent')
        with patch.object(safety.sys, 'platform', 'darwin'), patch.object(safety, '_darwin_descriptor_path', return_value=str(prefix)) as query, patch.object(safety.os, 'readlink', side_effect=AssertionError('procfs forbidden')):
            guard._assert_posix_prefix(prefix, 9)
            query.assert_called_once_with(9)
            query.return_value = str(prefix.with_name('moved'))
            with self.assertRaises(PermissionError):
                guard._assert_posix_prefix(prefix, 9)

    def test_bound_read_uses_same_darwin_query_instead_of_approved_fallback(self):
        with patch.object(safety, 'os', SimpleNamespace(name='posix')), patch.object(safety.sys, 'platform', 'darwin'), patch.object(safety, '_darwin_descriptor_path', return_value='/moved/report') as query:
            self.assertEqual(safety._bound_descriptor_path(3, '/approved/report'), '/moved/report')
            query.assert_called_once_with(3)
            query.side_effect = OSError('no current path')
            with self.assertRaisesRegex(OSError, 'no current path'):
                safety._bound_descriptor_path(3, '/approved/report')

    def test_delete_holds_symlink_inode_with_native_flags_not_its_target(self):
        info = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_dev=4, st_ino=8)
        native_os = SimpleNamespace(O_EVTONLY=0x8000, O_SYMLINK=0x200000, O_NONBLOCK=4, open=Mock(return_value=17), fstat=Mock(return_value=info))
        deletion = object.__new__(safety.ManagedDelete)
        deletion.validate = Mock()
        deletion.nodes = []
        deletion.directories = []
        path = Path('/owned/link')
        with patch.object(safety, 'os', native_os), patch.object(safety.sys, 'platform', 'darwin'):
            deletion._posix_open(path, 11)
        native_os.open.assert_called_once_with('link', 0x208004, dir_fd=11)
        self.assertEqual(deletion.nodes[0]['identity'], (4, 8))
        self.assertFalse(deletion.nodes[0]['directory'])
        self.assertEqual(deletion.directories, [])
        deletion.validate.assert_called_once_with(path)

    def test_missing_native_primitive_does_not_degrade_to_following_open(self):
        deletion = object.__new__(safety.ManagedDelete)
        deletion.validate = Mock()
        deletion.nodes = []
        native_os = SimpleNamespace(O_EVTONLY=0x8000, O_NONBLOCK=4, open=Mock())
        with patch.object(safety, 'os', native_os), patch.object(safety.sys, 'platform', 'darwin'):
            with self.assertRaisesRegex(OSError, 'Darwin no-follow'):
                deletion._posix_open(Path('/owned/link'), 11)
        native_os.open.assert_not_called()

    def test_delete_revalidates_policy_before_native_admission(self):
        deletion = object.__new__(safety.ManagedDelete)
        deletion.validate = Mock(side_effect=PermissionError('scope denied'))
        native_os = SimpleNamespace(open=Mock())
        with patch.object(safety, 'os', native_os), patch.object(safety.sys, 'platform', 'darwin'):
            with self.assertRaisesRegex(PermissionError, 'scope denied'):
                deletion._posix_open(Path('/owned/link'), 11)
        native_os.open.assert_not_called()

    def test_linux_leaf_adapter_keeps_existing_no_follow_path_flags(self):
        info = SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_dev=4, st_ino=8)
        native_os = SimpleNamespace(O_PATH=0x200000, O_NOFOLLOW=0x20000, open=Mock(return_value=17), fstat=Mock(return_value=info))
        deletion = object.__new__(safety.ManagedDelete)
        deletion.validate = Mock()
        deletion.nodes = []
        deletion.directories = []
        with patch.object(safety, 'os', native_os), patch.object(safety.sys, 'platform', 'linux'):
            deletion._posix_open(Path('/owned/link'), 11)
        native_os.open.assert_called_once_with('link', 0x220000, dir_fd=11)

    def test_delete_leaf_substitution_still_refused(self):
        deletion = object.__new__(safety.ManagedDelete)
        deletion._posix_directory_safe = Mock()
        deletion.parent = SimpleNamespace(_assert_posix_prefix=Mock())
        node = {'path': Path('/owned/link'), 'parent_fd': 11, 'identity': (4, 8)}
        native_os = SimpleNamespace(stat=Mock(return_value=SimpleNamespace(st_dev=4, st_ino=9)))
        with patch.object(safety, 'os', native_os):
            with self.assertRaisesRegex(PermissionError, 'identity was substituted'):
                deletion._posix_bound(node)
        native_os.stat.assert_called_once_with('link', dir_fd=11, follow_symlinks=False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
