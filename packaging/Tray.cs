using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

// Compiled with the inbox Windows .NET Framework compiler. No separate .NET SDK
// or desktop runtime is installed. Only the owner can signal this tray.
internal class Tray : ApplicationContext
{
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    private static readonly string Local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
    private static readonly string Platform = Path.Combine(Local, "En-GYM");
    private static readonly string Updates = Path.Combine(Platform, "updates");
    private static readonly string[] WorkerFiles = { @"core\updates.ts", @"server\updates.ts", @"scripts\release-apply.mjs", "package.json" };
    private readonly Control ui = new Control();
    private readonly NotifyIcon icon;
    private readonly RegisteredWaitHandle openWait, quitWait;
    private Process server;
    private bool ready, stopping, requestOpen = true;
    private readonly System.Windows.Forms.Timer exitTimeout = new System.Windows.Forms.Timer();

    private static void Notice(string message)
    {
        MessageBox.Show(message, "En-GYM", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    [STAThread]
    public static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        var user = WindowsIdentity.GetCurrent().User;
        string prefix = @"Local\En-GYM-" + user.Value;
        var rights = new EventWaitHandleSecurity();
        rights.SetAccessRuleProtection(true, false);
        rights.AddAccessRule(new EventWaitHandleAccessRule(user, EventWaitHandleRights.FullControl, AccessControlType.Allow));
        var mutexRights = new MutexSecurity();
        mutexRights.SetAccessRuleProtection(true, false);
        mutexRights.AddAccessRule(new MutexAccessRule(user, MutexRights.FullControl, AccessControlType.Allow));
        bool owner, unused;
        try
        {
            using (var mutex = new Mutex(true, prefix, out owner, mutexRights))
            using (var open = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Open", out unused, rights))
            using (var quit = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + "-Quit", out unused, rights))
            {
                bool shutdown = args.Length == 1 && args[0] == "--quit";
                if (!owner)
                {
                    if (shutdown) quit.Set(); else open.Set();
                    return 0;
                }
                try
                {
                    if (shutdown || HelperActive()) return 0;
                    Directory.CreateDirectory(Platform);
                    using (var gate = File.Open(Path.Combine(Platform, "program.lock"), FileMode.OpenOrCreate,
                        FileAccess.ReadWrite, FileShare.Read))
                    {
                        CleanOldWorkers();
                        if (File.Exists(Path.Combine(Updates, "recovery.json")) || File.Exists(Path.Combine(Updates, "pending.json")))
                        {
                            LaunchUpdater();
                            return 0;
                        }
                        using (var tray = new Tray(open, quit)) Application.Run(tray);
                    }
                }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception)
        {
            Notice("En-GYM could not start. Close any older copy, then try again. If this continues, run the installer to repair the app.");
            return 1;
        }
    }

    private static ProcessStartInfo Child(string exe, string args)
    {
        var p = new ProcessStartInfo(exe, args) { WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true };
        foreach (string key in new System.Collections.ArrayList(p.EnvironmentVariables.Keys))
        {
            if (key.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase) ||
                key.StartsWith("FIELDWORK_", StringComparison.OrdinalIgnoreCase) ||
                key.StartsWith("EN_GYM_", StringComparison.OrdinalIgnoreCase))
                p.EnvironmentVariables.Remove(key);
        }
        p.EnvironmentVariables["PATH"] = Environment.SystemDirectory + ";" +
            Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0");
        p.EnvironmentVariables["LOCALAPPDATA"] = Local;
        p.EnvironmentVariables["EN_GYM_INSTALLED"] = "1";
        p.EnvironmentVariables["FIELDWORK_PORT"] = "43128";
        p.EnvironmentVariables["FIELDWORK_INSTALL_ROOT"] = Root;
        p.EnvironmentVariables["FIELDWORK_SPEECH"] = Path.Combine(Platform, "components", "speech");
        return p;
    }

    private Tray(EventWaitHandle open, EventWaitHandle quit)
    {
        var handle = ui.Handle;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open En-GYM", null, delegate { Open(); });
        menu.Items.Add("Quit", null, delegate { Quit(); });
        icon = new NotifyIcon { Text = "En-GYM", Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath),
            ContextMenuStrip = menu, Visible = true };
        icon.DoubleClick += delegate { Open(); };
        openWait = ThreadPool.RegisterWaitForSingleObject(open, delegate { Dispatch(Open); }, null, -1, false);
        quitWait = ThreadPool.RegisterWaitForSingleObject(quit, delegate { Dispatch(Quit); }, null, -1, false);
        var p = Child(Path.Combine(Root, "runtime", "node.exe"), "server/main.ts");
        p.RedirectStandardInput = true;
        p.RedirectStandardOutput = true;
        p.RedirectStandardError = true;
        server = new Process { StartInfo = p, EnableRaisingEvents = true };
        server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == "EN_GYM_READY" || (e.Data != null && e.Data.StartsWith("EN_GYM_OPEN ", StringComparison.Ordinal)))
                Dispatch(delegate { Receive(e.Data); });
        };
        // Don't log sensitive handoffs, AI responses or filesystem paths.
        server.ErrorDataReceived += delegate { };
        server.Exited += delegate { Dispatch(ServerEnded); };
        if (!server.Start()) throw new IOException("Service start failed.");
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
        exitTimeout.Interval = 6000;
        exitTimeout.Tick += delegate
        {
            exitTimeout.Stop();
            if (!server.HasExited) server.Kill();
        };
    }

    private void Dispatch(Action action)
    {
        if (ui.IsDisposed) return;
        try { ui.BeginInvoke(action); } catch (InvalidOperationException) { }
    }

    private void Open()
    {
        if (stopping) return;
        if (!ready) { requestOpen = true; return; }
        Send("OPEN");
    }

    private void Send(string command)
    {
        try { server.StandardInput.WriteLine(command); server.StandardInput.Flush(); }
        catch (IOException) { }
        catch (InvalidOperationException) { }
    }

    private void Receive(string line)
    {
        if (stopping) return;
        if (line == "EN_GYM_READY")
        {
            ready = true;
            if (requestOpen) { requestOpen = false; Open(); }
            return;
        }
        string address = line.Substring("EN_GYM_OPEN ".Length);
        if (ready && Regex.IsMatch(address, @"\Ahttp://127\.0\.0\.1:43128/launch#[a-f0-9]{64}\z"))
        {
            try { Process.Start(new ProcessStartInfo(address) { UseShellExecute = true }); }
            catch { Notice("Windows could not open your browser. Set a default browser and choose Open En-GYM again."); }
        }
    }

    private void Quit()
    {
        if (stopping) return;
        stopping = true;
        Send("QUIT");
        exitTimeout.Start();
    }

    private void ServerEnded()
    {
        int code = server.ExitCode;
        if (code == 75)
        {
            try { LaunchUpdater(); }
            catch { Notice("The update could not start. Open En-GYM again to retry."); }
        }
        else if (!stopping) Notice(ready ? "The local service stopped. Open En-GYM again." :
            "En-GYM could not start its local service. Close other En-GYM windows and try again.");
        ExitThread();
    }

    private static bool HelperActive()
    {
        string marker = Path.Combine(Updates, "native-helper.json");
        if (!File.Exists(marker)) return false;
        try
        {
            if (new FileInfo(marker).Length > 2048) return false;
            var info = new System.Web.Script.Serialization.JavaScriptSerializer()
                .Deserialize<System.Collections.Generic.Dictionary<string, string>>(File.ReadAllText(marker));
            string id, ticks;
            int pid;
            if (info == null || !info.TryGetValue("pid", out id) || !info.TryGetValue("ticks", out ticks) ||
                !Int32.TryParse(id, out pid) || pid <= 0) return false;
            using (var p = Process.GetProcessById(pid))
            {
                string exe = p.MainModule.FileName;
                return p.StartTime.ToUniversalTime().Ticks.ToString() == ticks &&
                    exe.StartsWith(Updates + "\\worker-", StringComparison.OrdinalIgnoreCase) &&
                    Path.GetFileName(exe).Equals("node.exe", StringComparison.OrdinalIgnoreCase);
            }
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (FileNotFoundException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return false; }
    }

    private static void LaunchUpdater()
    {
        Directory.CreateDirectory(Updates);
        string worker = Path.Combine(Updates, "worker-" + Guid.NewGuid().ToString("N"));
        foreach (string file in WorkerFiles)
        {
            string to = Path.Combine(worker, file);
            Directory.CreateDirectory(Path.GetDirectoryName(to));
            File.Copy(Path.Combine(Root, file), to);
        }
        string exe = Path.Combine(worker, "node.exe");
        File.Copy(Path.Combine(Root, "runtime", "node.exe"), exe);
        var start = Child(exe, "\"" + Path.Combine(worker, @"scripts\release-apply.mjs") + "\"");
        start.WorkingDirectory = worker;
        using (var p = Process.Start(start))
        {
            string marker = Path.Combine(Updates, "native-helper.json");
            string temp = Path.Combine(Updates, Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                File.WriteAllText(temp, "{\"pid\":\"" + p.Id + "\",\"ticks\":\"" + p.StartTime.ToUniversalTime().Ticks + "\"}");
                if (File.Exists(marker)) File.Replace(temp, marker, null);
                else File.Move(temp, marker);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
    }

    private static bool RegularDirectory(string dir)
    {
        return Directory.Exists(dir) && (File.GetAttributes(dir) & FileAttributes.ReparsePoint) == 0;
    }

    private static void CleanOldWorkers()
    {
        // The current user mutex serializes starts. The previous updater may
        // still be returning from launching the tray, so respect its image lock.
        if (!RegularDirectory(Platform) || !RegularDirectory(Updates)) return;
        foreach (string dir in Directory.GetDirectories(Updates, "worker-*"))
        {
            if (!Regex.IsMatch(Path.GetFileName(dir), @"\Aworker-[0-9a-f]{32}\z") || !RegularDirectory(dir)) continue;
            try
            {
                string node = Path.Combine(dir, "node.exe");
                if (File.Exists(node))
                {
                    if ((File.GetAttributes(node) & FileAttributes.ReparsePoint) != 0) continue;
                    using (File.Open(node, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
                    File.Delete(node);
                }
                foreach (string member in WorkerFiles)
                {
                    string file = Path.Combine(dir, member);
                    if (RegularDirectory(Path.GetDirectoryName(file)) && File.Exists(file) &&
                        (File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0) File.Delete(file);
                }
                foreach (string name in new[] { "scripts", "core", "server" })
                {
                    string child = Path.Combine(dir, name);
                    if (RegularDirectory(child)) Directory.Delete(child, false);
                }
                Directory.Delete(dir, false);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            openWait.Unregister(null); quitWait.Unregister(null);
            exitTimeout.Dispose();
            icon.Visible = false;
            icon.ContextMenuStrip.Dispose(); icon.Dispose();
            if (server != null) { if (!server.HasExited) server.Kill(); server.Dispose(); }
            ui.Dispose();
        }
        base.Dispose(disposing);
    }
}
