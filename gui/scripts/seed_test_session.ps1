# Local verification helper: seed a GUI test session into Windows Credential
# Manager (keyring windows-native contract: target "{user}.{service}", UTF-16LE blob)
$code = @'
using System;
using System.Runtime.InteropServices;

public class CredMan {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, int flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDeleteW(string targetName, int type, int flags);
}
'@
Add-Type -TypeDefinition $code

$json = '{"id":"u_local_test","name":"本地测试","email":"local-test@believeboy.com","operator_name_zh":"测试运营","is_admin":true,"is_active":true,"role_type":"admin","session_id":"sess_local_test","api_key":"mock-key"}'
$blob = [System.Text.Encoding]::Unicode.GetBytes($json)
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($blob.Length)
[System.Runtime.InteropServices.Marshal]::Copy($blob, 0, $ptr, $blob.Length)

$cred = New-Object CredMan+CREDENTIAL
$cred.Flags = 0
$cred.Type = 1            # CRED_TYPE_GENERIC
$cred.TargetName = "default.believeboy-gui"
$cred.Comment = "local test session (auto-removed after verification)"
$cred.CredentialBlobSize = $blob.Length
$cred.CredentialBlob = $ptr
$cred.Persist = 2         # CRED_PERSIST_LOCAL_MACHINE
$cred.AttributeCount = 0
$cred.Attributes = [IntPtr]::Zero
$cred.TargetAlias = ""
$cred.UserName = "default"

$ok = [CredMan]::CredWrite([ref]$cred, 0)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
if ($ok) { Write-Output "session seeded" } else { Write-Output "CredWrite failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }
