# Standalone shader probe: replicates directx_renderer.rs runtime compile path
# (alpha_correction.hlsl + "\n" + color_text_raster.hlsl concat, D3DCompile /O3)
param(
    [string]$HlslDir = "C:\Users\damon\Documents\believeboyDashboard\gui\third-party\gpui\src\platform\windows"
)
$code = @'
using System;
using System.Runtime.InteropServices;

public class D3DProbe {
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate IntPtr GetBufferPointerDelegate(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate IntPtr GetBufferSizeDelegate(IntPtr self);

    [DllImport("d3dcompiler_47.dll", CharSet = CharSet.Ansi, SetLastError = false)]
    public static extern int D3DCompile(
        byte[] pSrcData, IntPtr SrcDataSize, string pSourceName,
        IntPtr pDefines, IntPtr pInclude,
        string pEntrypoint, string pTarget, uint Flags1, uint Flags2,
        out IntPtr ppCode, out IntPtr ppErrorMsgs);

    public static string BlobToString(IntPtr blob) {
        if (blob == IntPtr.Zero) return "";
        var vtbl = Marshal.ReadIntPtr(blob);
        var fnPtr = Marshal.ReadIntPtr(vtbl, 3 * IntPtr.Size);
        var getPtr = (GetBufferPointerDelegate)Marshal.GetDelegateForFunctionPointer(fnPtr, typeof(GetBufferPointerDelegate));
        var fnSize = Marshal.ReadIntPtr(vtbl, 4 * IntPtr.Size);
        var getSize = (GetBufferSizeDelegate)Marshal.GetDelegateForFunctionPointer(fnSize, typeof(GetBufferSizeDelegate));
        IntPtr p = getPtr(blob);
        IntPtr n = getSize(blob);
        if (p == IntPtr.Zero || n == IntPtr.Zero) return "";
        return Marshal.PtrToStringAnsi(p, (int)n);
    }
}
'@
Add-Type -TypeDefinition $code

$alpha = [IO.File]::ReadAllBytes("$HlslDir\alpha_correction.hlsl")
$body  = [IO.File]::ReadAllBytes("$HlslDir\color_text_raster.hlsl")
$nl    = [byte][char]"`n"
$src   = New-Object byte[] ($alpha.Length + 1 + $body.Length)
[Array]::Copy($alpha, 0, $src, 0, $alpha.Length)
$src[$alpha.Length] = $nl
[Array]::Copy($body, 0, $src, $alpha.Length + 1, $body.Length)

$cases = @(
    @{ ep = "emoji_rasterization_vertex";   target = "vs_4_1" },
    @{ ep = "emoji_rasterization_fragment"; target = "ps_4_1" }
)
foreach ($c in $cases) {
    [IntPtr]$codeBlob = [IntPtr]::Zero
    [IntPtr]$errBlob  = [IntPtr]::Zero
    $hr = [D3DProbe]::D3DCompile($src, [IntPtr]$src.Length, "color_text_raster.hlsl",
        [IntPtr]::Zero, [IntPtr]::Zero, $c.ep, $c.target, 3, 0, [ref]$codeBlob, [ref]$errBlob)
    if ($hr -eq 0) {
        Write-Output ("PASS {0} ({1})" -f $c.ep, $c.target)
    } else {
        Write-Output ("FAIL hr=0x{0:X8} {1} ({2})" -f $hr, $c.ep, $c.target)
        Write-Output ([D3DProbe]::BlobToString($errBlob))
    }
}
