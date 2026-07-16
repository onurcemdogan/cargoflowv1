param(
  [Parameter(Mandatory = $true)]
  [string]$PrinterName,

  [Parameter(Mandatory = $true)]
  [string]$ZplBase64,

  [Parameter(Mandatory = $true)]
  [string]$DocumentName
)

$source = @"
using System;
using System.Runtime.InteropServices;

public static class CargoFlowRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }

  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string printerName, out IntPtr printer, IntPtr defaults);

  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr printer);

  [DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr printer, int level, [In] DOCINFO docInfo);

  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr printer);

  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr printer);

  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr printer);

  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr printer, byte[] bytes, int count, out int written);

  public static int Send(string printerName, string documentName, byte[] bytes) {
    IntPtr printer;
    if (!OpenPrinter(printerName, out printer, IntPtr.Zero))
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

    try {
      var docInfo = new DOCINFO {
        pDocName = documentName,
        pDataType = "RAW",
        pOutputFile = null
      };
      int jobId = StartDocPrinter(printer, 1, docInfo);
      if (jobId <= 0)
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());

      try {
        if (!StartPagePrinter(printer))
          throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
          int written;
          if (!WritePrinter(printer, bytes, bytes.Length, out written) || written != bytes.Length)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        } finally {
          EndPagePrinter(printer);
        }
      } finally {
        EndDocPrinter(printer);
      }
      return jobId;
    } finally {
      ClosePrinter(printer);
    }
  }
}
"@

Add-Type -TypeDefinition $source -Language CSharp
$bytes = [Convert]::FromBase64String($ZplBase64)
$jobId = [CargoFlowRawPrinter]::Send($PrinterName, $DocumentName, $bytes)
Write-Output $jobId
