"""Keyboard setup must not consume the caller's command stream."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch


class KeyboardStdioTest(unittest.TestCase):
    def test_keyboard_process_cannot_inherit_interactive_commands(self):
        source = Path(__file__).resolve().parents[1] / 'tools/daangn/kbd.py'
        spec = importlib.util.spec_from_file_location('isolated_keyboard', source)
        keyboard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(keyboard)
        connection = Mock()
        connection.recv.return_value = b'\x00'
        child = Mock()
        with patch.object(keyboard, 'adb') as adb, \
                patch.object(keyboard.subprocess, 'Popen', return_value=child) as spawn, \
                patch.object(keyboard.socket, 'create_connection', return_value=connection), \
                patch.object(keyboard.time, 'sleep'):
            controller = keyboard.Kbd()
            self.assertEqual(spawn.call_args.kwargs['stdin'], subprocess.DEVNULL)
            controller.paste('test')
            self.assertEqual(connection.sendall.call_args.args[0][0], 9)
            controller.close()
            child.kill.assert_called_once()
            connection.close.assert_called_once()
            self.assertIn('forward', adb.call_args.args)
            self.assertIn('--remove', adb.call_args.args)


if __name__ == '__main__':
    unittest.main()
