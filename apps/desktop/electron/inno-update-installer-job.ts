/** Bounded private Win32 job. No shell, privilege change, policy override, or global process scan. */
export const INNO_UPDATE_INSTALLER_JOB_FUNCTIONS = String.raw`
function Initialize-YoutabInstallerJobNative {
  if ('YoutabInstallerJobNative' -as [type]) {return}
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class YoutabInstallerJobNative {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
    public uint cb; public string reserved,desktop,title; public uint x,y,width,height,xCount,yCount,fill,flags;
    public ushort show,reservedBytes; public IntPtr reservedPointer,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation {public IntPtr process,thread;public uint processId,threadId;}
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime,jobTime;public uint flags;public UIntPtr minimumWorkingSet,maximumWorkingSet;
    public uint activeLimit;public UIntPtr affinity;public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {public BasicLimits basic;public IoCounters io;public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;}
  [StructLayout(LayoutKind.Sequential)] struct Accounting {public long user,kernel,periodUser,periodKernel;public uint pageFaults,totalProcesses,activeProcesses,terminatedProcesses;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int informationClass,ref ExtendedLimits limits,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int informationClass,out Accounting accounting,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInformation information);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  // Retain uncertain job/process handles. Never close/release them as if drain had succeeded.
  sealed class RetainedJob {public IntPtr job,process;public bool assigned;}
  static readonly List<RetainedJob> retained = new List<RetainedJob>();
  static void Retain(IntPtr job,IntPtr process,bool assigned) {lock(retained) {retained.Add(new RetainedJob {job=job,process=process,assigned=assigned});}}
  public static bool TryDrainRetained() {
    lock(retained) {
      for(int i=retained.Count-1;i>=0;i--) {
        var item=retained[i];bool drained=false;
        try {drained=Exited(item.process) && (!item.assigned || Active(item.job)==0);} catch { /* Unknown stays retained. */ }
        if(drained) {CloseHandle(item.process);if(item.job!=IntPtr.Zero) CloseHandle(item.job);retained.RemoveAt(i);}
      }
      return retained.Count==0;
    }
  }
  public static string QuoteArgument(string argument) {
    if(argument==null || argument.IndexOf('\0')>=0) throw new ArgumentException("Invalid native argument.");
    if(argument.Length>0 && argument.IndexOfAny(new char[]{' ','\t','\n','\r','\v','\"'})<0) return argument;
    var result=new StringBuilder("\"");int slashes=0;
    foreach(char c in argument) {
      if(c=='\\') {slashes++;continue;}
      if(c=='\"') {result.Append('\\',slashes*2+1);result.Append('\"');}
      else {result.Append('\\',slashes);result.Append(c);}
      slashes=0;
    }
    result.Append('\\',slashes*2);result.Append('\"');return result.ToString();
  }
  static uint Active(IntPtr job) {
    Accounting value;
    if(!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Win32Exception();
    return value.activeProcesses;
  }
  static bool Exited(IntPtr process) {
    uint result=WaitForSingleObject(process,0);
    if(result==0xffffffff) throw new Win32Exception();
    return result==0;
  }
  static bool Drain(IntPtr job,IntPtr process,bool assigned,int milliseconds) {
    if(assigned) {TerminateJobObject(job,0xe0000001);} else {TerminateProcess(process,0xe0000001);}
    var deadline=Stopwatch.StartNew();
    do {
      try {if(Exited(process) && (!assigned || Active(job)==0)) return true;} catch { /* Cannot acknowledge an unknown live state. */ }
      Thread.Sleep(25);
    }while(deadline.ElapsedMilliseconds<milliseconds);
    return false;
  }
  public static int Run(string executable,string[] arguments,int timeoutMs) {
    if(timeoutMs<1 || timeoutMs>900000) throw new ArgumentOutOfRangeException("timeoutMs");
    if(String.IsNullOrEmpty(executable) || executable.IndexOf('\0')>=0 || executable.Length<3 || !Char.IsLetter(executable[0]) || executable[1]!=':' || (executable[2]!='\\' && executable[2]!='/')) throw new ArgumentException("A local absolute executable is required.");
    if(!File.Exists(executable) || !String.Equals(Path.GetExtension(executable),".exe",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("A local absolute executable is required.");
    executable=Path.GetFullPath(executable);
    if(arguments==null) throw new ArgumentNullException("arguments");
    var command=new StringBuilder(QuoteArgument(executable));
    foreach(string argument in arguments) {command.Append(' ');command.Append(QuoteArgument(argument));}
    if(command.Length>=32767) throw new ArgumentException("Native command line exceeds Windows limit.");
    IntPtr job=IntPtr.Zero;var child=new ProcessInformation();bool assigned=false,safelyDrained=true;
    try {
      job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero) throw new Win32Exception();
      var limits=new ExtendedLimits();limits.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Win32Exception();
      var startup=new Startup();startup.cb=(uint)Marshal.SizeOf(typeof(Startup));
      if(!CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,Path.GetDirectoryName(executable),ref startup,out child)) throw new Win32Exception();
      safelyDrained=false;
      // The only initially uncontained process is still suspended and cannot spawn children.
      if(!AssignProcessToJobObject(job,child.process)) throw new Win32Exception();
      assigned=true;
      if(ResumeThread(child.thread)==0xffffffff) throw new Win32Exception();
      var elapsed=Stopwatch.StartNew();
      for(;;) {
        if(Exited(child.process) && Active(job)==0) {
          safelyDrained=true;uint exitCode;
          if(!GetExitCodeProcess(child.process,out exitCode)) throw new Win32Exception();
          return unchecked((int)exitCode);
        }
        if(elapsed.ElapsedMilliseconds>=timeoutMs) throw new TimeoutException("YOUTAB_INSTALLER_TIMEOUT");
        Thread.Sleep(25);
      }
    }catch {
      if(child.process!=IntPtr.Zero && !safelyDrained) {
        safelyDrained=Drain(job,child.process,assigned,30000);
        if(!safelyDrained) throw new InvalidOperationException("YOUTAB_INSTALLER_STILL_RUNNING");
      }
      throw;
    }finally {
      if(child.thread!=IntPtr.Zero) CloseHandle(child.thread);
      if(safelyDrained) {if(child.process!=IntPtr.Zero) CloseHandle(child.process);if(job!=IntPtr.Zero) CloseHandle(job);}
      else {Retain(job,child.process,assigned);}
    }
  }
}
'@ -ErrorAction Stop
}
function Invoke-YoutabBoundedInstaller([string]$Exe,[string[]]$Arguments,[int]$TimeoutMs=600000) {
  Initialize-YoutabInstallerJobNative
  return [YoutabInstallerJobNative]::Run($Exe,$Arguments,$TimeoutMs)
}
function Test-YoutabInstallerJobsDrained {
  Initialize-YoutabInstallerJobNative
  return [YoutabInstallerJobNative]::TryDrainRetained()
}
`
