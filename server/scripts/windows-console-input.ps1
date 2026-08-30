$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TermRail
{
    public sealed class ConsoleInputInjectionException : Exception
    {
        public bool DeliveryUnknown { get; private set; }

        public ConsoleInputInjectionException(
            string message,
            bool deliveryUnknown,
            Exception innerException
        ) : base(message, innerException)
        {
            DeliveryUnknown = deliveryUnknown;
        }
    }

    public static class ConsoleInputBridge
    {
        private const ushort KeyEvent = 0x0001;
        private const ushort VkBack = 0x08;
        private const ushort VkTab = 0x09;
        private const ushort VkReturn = 0x0D;
        private const ushort VkEscape = 0x1B;
        private const ushort VkSpace = 0x20;
        private const ushort VkPrior = 0x21;
        private const ushort VkNext = 0x22;
        private const ushort VkEnd = 0x23;
        private const ushort VkHome = 0x24;
        private const ushort VkLeft = 0x25;
        private const ushort VkUp = 0x26;
        private const ushort VkRight = 0x27;
        private const ushort VkDown = 0x28;
        private const ushort VkInsert = 0x2D;
        private const ushort VkDelete = 0x2E;
        private const ushort VkF1 = 0x70;
        private const ushort VkPacket = 0xE7;

        private const uint LeftAltPressed = 0x0002;
        private const uint LeftCtrlPressed = 0x0008;
        private const uint ShiftPressed = 0x0010;
        private const uint EnhancedKey = 0x0100;

        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);
        private const string SelfTestEnv = "TERMRAIL_WINDOWS_INPUT_SELF_TEST";
        private const string SelfTestSafeInput = "__termrail_test_err_safe__";
        private const string SelfTestUnknownInput = "__termrail_test_err_unknown__";

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct KeyEventRecord
        {
            [MarshalAs(UnmanagedType.Bool)]
            public bool KeyDown;
            public ushort RepeatCount;
            public ushort VirtualKeyCode;
            public ushort VirtualScanCode;
            public char UnicodeChar;
            public uint ControlKeyState;
        }

        [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
        private struct InputRecord
        {
            [FieldOffset(0)]
            public ushort EventType;
            [FieldOffset(4)]
            public KeyEventRecord KeyEvent;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FreeConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool WriteConsoleInputW(
            IntPtr consoleInput,
            InputRecord[] buffer,
            uint length,
            out uint written
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static void Run()
        {
            TextReader protocolInput = Console.In;
            TextWriter protocolOutput = Console.Out;
            protocolOutput.WriteLine("READY");
            protocolOutput.Flush();

            string line;
            while ((line = protocolInput.ReadLine()) != null)
            {
                string[] fields = line.Split(new[] { '\t' }, 3);
                string requestId = fields.Length > 0 ? fields[0] : "?";
                string response;
                try
                {
                    if (fields.Length != 3)
                    {
                        throw new InvalidDataException("expected id, process id, and input data");
                    }

                    uint processId;
                    if (!UInt32.TryParse(fields[1], out processId))
                    {
                        throw new InvalidDataException("invalid process id");
                    }

                    string data = Encoding.UTF8.GetString(Convert.FromBase64String(fields[2]));
                    string selfTestResponse = TryHandleSelfTest(requestId, processId, data);
                    if (selfTestResponse != null)
                    {
                        response = selfTestResponse;
                    }
                    else
                    {
                        Inject(processId, data);
                        response = "ACK\t" + requestId;
                    }
                }
                catch (ConsoleInputInjectionException error)
                {
                    string message = Convert.ToBase64String(Encoding.UTF8.GetBytes(error.Message));
                    string kind = error.DeliveryUnknown ? "ERR_UNKNOWN" : "ERR_SAFE";
                    response = kind + "\t" + requestId + "\t" + message;
                }
                catch (Exception error)
                {
                    string message = Convert.ToBase64String(Encoding.UTF8.GetBytes(error.Message));
                    response = "ERR_SAFE\t" + requestId + "\t" + message;
                }
                protocolOutput.WriteLine(response);
                protocolOutput.Flush();
            }
        }

        private static string TryHandleSelfTest(
            string requestId,
            uint processId,
            string data
        )
        {
            if (
                Environment.GetEnvironmentVariable(SelfTestEnv) != "1" ||
                processId != 0
            )
            {
                return null;
            }

            if (data == SelfTestSafeInput)
            {
                return ErrorResponse(
                    "ERR_SAFE",
                    requestId,
                    "self-test safe failure before WriteConsoleInputW"
                );
            }
            if (data == SelfTestUnknownInput)
            {
                return ErrorResponse(
                    "ERR_UNKNOWN",
                    requestId,
                    "self-test unknown failure after WriteConsoleInputW"
                );
            }
            return null;
        }

        private static string ErrorResponse(
            string kind,
            string requestId,
            string message
        )
        {
            return kind + "\t" + requestId + "\t" +
                Convert.ToBase64String(Encoding.UTF8.GetBytes(message));
        }

        private static void Inject(uint processId, string data)
        {
            IntPtr consoleInput = InvalidHandleValue;
            bool writeAttempted = false;
            try
            {
                AttachWithRetry(processId);
                consoleInput = CreateFileW(
                    "CONIN$",
                    GenericRead | GenericWrite,
                    FileShareRead | FileShareWrite,
                    IntPtr.Zero,
                    OpenExisting,
                    0,
                    IntPtr.Zero
                );
                if (consoleInput == InvalidHandleValue)
                {
                    throw new InvalidOperationException(
                        "failed to open CONIN$: " + Marshal.GetLastWin32Error()
                    );
                }

                InputRecord[] records = Translate(data).ToArray();
                if (records.Length == 0)
                {
                    return;
                }

                int offset = 0;
                while (offset < records.Length)
                {
                    int count = Math.Min(512, records.Length - offset);
                    InputRecord[] chunk = new InputRecord[count];
                    Array.Copy(records, offset, chunk, 0, count);

                    uint written;
                    writeAttempted = true;
                    if (!WriteConsoleInputW(consoleInput, chunk, (uint)count, out written))
                    {
                        throw new InvalidOperationException(
                            "WriteConsoleInputW failed: " + Marshal.GetLastWin32Error()
                        );
                    }
                    if (written == 0)
                    {
                        throw new InvalidOperationException("WriteConsoleInputW wrote no records");
                    }
                    offset += (int)written;
                }
            }
            catch (Exception error)
            {
                throw new ConsoleInputInjectionException(
                    error.Message,
                    writeAttempted,
                    error
                );
            }
            finally
            {
                if (consoleInput != InvalidHandleValue)
                {
                    CloseHandle(consoleInput);
                }
                FreeConsole();
            }
        }

        private static void AttachWithRetry(uint processId)
        {
            for (int attempt = 0; attempt < 40; attempt++)
            {
                FreeConsole();
                if (AttachConsole(processId))
                {
                    return;
                }
                Thread.Sleep(25);
            }

            throw new InvalidOperationException(
                "AttachConsole failed for process " + processId + ": " + Marshal.GetLastWin32Error()
            );
        }

        private static List<InputRecord> Translate(string data)
        {
            List<InputRecord> records = new List<InputRecord>();
            for (int index = 0; index < data.Length; index++)
            {
                char value = data[index];
                if (value == '\x1B')
                {
                    int consumed = TranslateEscapeSequence(data, index, records);
                    index += consumed - 1;
                    continue;
                }
                if (value == '\r')
                {
                    AppendKey(records, VkReturn, '\r', 0);
                    continue;
                }
                if (value == '\n')
                {
                    AppendKey(records, (ushort)'J', '\n', LeftCtrlPressed);
                    continue;
                }
                if (value == '\x7F' || value == '\b')
                {
                    AppendKey(records, VkBack, '\b', 0);
                    continue;
                }
                if (value == '\t')
                {
                    AppendKey(records, VkTab, '\t', 0);
                    continue;
                }
                if (value < ' ')
                {
                    AppendControlCharacter(records, value);
                    continue;
                }

                AppendKey(records, VkPacket, value, 0);
            }
            return records;
        }

        private static int TranslateEscapeSequence(
            string data,
            int start,
            List<InputRecord> records
        )
        {
            if (start + 1 >= data.Length)
            {
                AppendKey(records, VkEscape, '\x1B', 0);
                return 1;
            }

            char prefix = data[start + 1];
            if (prefix == '[')
            {
                int end = start + 2;
                while (end < data.Length && (data[end] < '@' || data[end] > '~'))
                {
                    end++;
                }
                if (end < data.Length)
                {
                    string sequence = data.Substring(start + 2, end - start - 2);
                    char final = data[end];
                    if (AppendCsiKey(records, sequence, final))
                    {
                        return end - start + 1;
                    }
                }
            }
            else if (prefix == 'O' && start + 2 < data.Length)
            {
                ushort virtualKey;
                if (TryMapSs3Key(data[start + 2], out virtualKey))
                {
                    AppendKey(records, virtualKey, '\0', EnhancedKey);
                    return 3;
                }
            }
            else
            {
                AppendKey(records, VkPacket, prefix, LeftAltPressed);
                return 2;
            }

            AppendKey(records, VkEscape, '\x1B', 0);
            return 1;
        }

        private static bool AppendCsiKey(
            List<InputRecord> records,
            string parameters,
            char final
        )
        {
            uint modifiers = 0;
            string[] parts = parameters.Split(';');
            if (parts.Length > 1)
            {
                int modifierParameter;
                if (Int32.TryParse(parts[parts.Length - 1], out modifierParameter))
                {
                    modifiers = ModifiersFromParameter(modifierParameter);
                }
            }

            ushort virtualKey = 0;
            switch (final)
            {
                case 'A': virtualKey = VkUp; break;
                case 'B': virtualKey = VkDown; break;
                case 'C': virtualKey = VkRight; break;
                case 'D': virtualKey = VkLeft; break;
                case 'H': virtualKey = VkHome; break;
                case 'F': virtualKey = VkEnd; break;
                case 'Z':
                    AppendKey(records, VkTab, '\t', ShiftPressed);
                    return true;
                case '~':
                    int keyNumber;
                    if (!Int32.TryParse(parts[0], out keyNumber))
                    {
                        return false;
                    }
                    virtualKey = VirtualKeyFromTildeNumber(keyNumber);
                    break;
                default:
                    return false;
            }

            if (virtualKey == 0)
            {
                return false;
            }
            AppendKey(records, virtualKey, '\0', modifiers | EnhancedKey);
            return true;
        }

        private static ushort VirtualKeyFromTildeNumber(int number)
        {
            switch (number)
            {
                case 1: return VkHome;
                case 2: return VkInsert;
                case 3: return VkDelete;
                case 4: return VkEnd;
                case 5: return VkPrior;
                case 6: return VkNext;
                case 11: return VkF1;
                case 12: return VkF1 + 1;
                case 13: return VkF1 + 2;
                case 14: return VkF1 + 3;
                case 15: return VkF1 + 4;
                case 17: return VkF1 + 5;
                case 18: return VkF1 + 6;
                case 19: return VkF1 + 7;
                case 20: return VkF1 + 8;
                case 21: return VkF1 + 9;
                case 23: return VkF1 + 10;
                case 24: return VkF1 + 11;
                default: return 0;
            }
        }

        private static bool TryMapSs3Key(char value, out ushort virtualKey)
        {
            switch (value)
            {
                case 'A': virtualKey = VkUp; return true;
                case 'B': virtualKey = VkDown; return true;
                case 'C': virtualKey = VkRight; return true;
                case 'D': virtualKey = VkLeft; return true;
                case 'H': virtualKey = VkHome; return true;
                case 'F': virtualKey = VkEnd; return true;
                case 'P': virtualKey = VkF1; return true;
                case 'Q': virtualKey = VkF1 + 1; return true;
                case 'R': virtualKey = VkF1 + 2; return true;
                case 'S': virtualKey = VkF1 + 3; return true;
                default: virtualKey = 0; return false;
            }
        }

        private static uint ModifiersFromParameter(int parameter)
        {
            switch (parameter)
            {
                case 2: return ShiftPressed;
                case 3: return LeftAltPressed;
                case 4: return ShiftPressed | LeftAltPressed;
                case 5: return LeftCtrlPressed;
                case 6: return ShiftPressed | LeftCtrlPressed;
                case 7: return LeftAltPressed | LeftCtrlPressed;
                case 8: return ShiftPressed | LeftAltPressed | LeftCtrlPressed;
                default: return 0;
            }
        }

        private static void AppendControlCharacter(List<InputRecord> records, char value)
        {
            if (value >= '\x01' && value <= '\x1A')
            {
                ushort virtualKey = (ushort)('A' + value - 1);
                AppendKey(records, virtualKey, value, LeftCtrlPressed);
                return;
            }
            if (value == '\0')
            {
                AppendKey(records, VkSpace, '\0', LeftCtrlPressed);
                return;
            }

            AppendKey(records, VkPacket, value, LeftCtrlPressed);
        }

        private static void AppendKey(
            List<InputRecord> records,
            ushort virtualKey,
            char unicodeChar,
            uint controlKeyState
        )
        {
            records.Add(NewKeyRecord(true, virtualKey, unicodeChar, controlKeyState));
            records.Add(NewKeyRecord(false, virtualKey, unicodeChar, controlKeyState));
        }

        private static InputRecord NewKeyRecord(
            bool keyDown,
            ushort virtualKey,
            char unicodeChar,
            uint controlKeyState
        )
        {
            InputRecord record = new InputRecord();
            record.EventType = KeyEvent;
            record.KeyEvent = new KeyEventRecord
            {
                KeyDown = keyDown,
                RepeatCount = 1,
                VirtualKeyCode = virtualKey,
                VirtualScanCode = 0,
                UnicodeChar = unicodeChar,
                ControlKeyState = controlKeyState
            };
            return record;
        }

        private static bool StartsWith(string value, int start, string expected)
        {
            return value.Length - start >= expected.Length &&
                String.CompareOrdinal(value, start, expected, 0, expected.Length) == 0;
        }
    }
}
'@

Add-Type -TypeDefinition $source
[TermRail.ConsoleInputBridge]::Run()
