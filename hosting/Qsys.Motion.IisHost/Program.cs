using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Yarp.ReverseProxy.Configuration;

var builder = WebApplication.CreateBuilder(args);
// One Node process per IIS application pool. Use only loopback for the private backend.
var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
var backendPort = ((IPEndPoint)listener.LocalEndpoint).Port;
listener.Stop();
builder.Services.AddSingleton(new NodeSettings(builder.Environment.ContentRootPath, backendPort));
builder.Services.AddHostedService<NodeSupervisor>();
builder.Services.AddReverseProxy().LoadFromMemory(
    [new RouteConfig { RouteId = "node", ClusterId = "node", Match = new RouteMatch { Path = "{**path}" } }],
    [new ClusterConfig
    {
        ClusterId = "node",
        Destinations = new Dictionary<string, DestinationConfig>
        {
            ["local"] = new() { Address = $"http://127.0.0.1:{backendPort}/" }
        }
    }]);
var app = builder.Build();
app.MapReverseProxy();
app.Run();

internal sealed record NodeSettings(string Root, int Port);

internal sealed class NodeSupervisor(NodeSettings settings, ILogger<NodeSupervisor> logger) : BackgroundService
{
    private Process? node;
    private readonly TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private WindowsJob? job;

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        if (OperatingSystem.IsWindows()) job = new WindowsJob();
        await base.StartAsync(cancellationToken);
        await ready.Task.WaitAsync(TimeSpan.FromSeconds(45), cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var binary = Path.Combine(settings.Root, "runtime", OperatingSystem.IsWindows() ? "node.exe" : "node");
                var start = new ProcessStartInfo(binary)
                {
                    WorkingDirectory = Path.Combine(settings.Root, "app"),
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true
                };
                start.ArgumentList.Add("server/index.js");
                start.Environment["PORT"] = settings.Port.ToString();
                start.Environment["HOST"] = "127.0.0.1";
                start.Environment["DATA_DIR"] = Environment.GetEnvironmentVariable("MOTION_DATA_DIR")
                    ?? Path.Combine(settings.Root, "data");
                start.Environment.Remove("TLS_KEY");
                start.Environment.Remove("TLS_CERT");
                node = Process.Start(start) ?? throw new InvalidOperationException("Node could not start");
                job?.Assign(node);
                node.OutputDataReceived += (_, e) => { if (e.Data is not null) logger.LogInformation("Node: {Line}", e.Data); };
                node.ErrorDataReceived += (_, e) => { if (e.Data is not null) logger.LogError("Node: {Line}", e.Data); };
                node.BeginOutputReadLine();
                node.BeginErrorReadLine();
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
                var healthy = false;
                for (var attempt = 0; attempt < 100; attempt++)
                {
                    stoppingToken.ThrowIfCancellationRequested();
                    if (node.HasExited) throw new InvalidOperationException($"Node exited: {node.ExitCode}");
                    try
                    {
                        using var response = await http.GetAsync($"http://127.0.0.1:{settings.Port}/api/health", stoppingToken);
                        if (response.IsSuccessStatusCode) { healthy = true; ready.TrySetResult(); break; }
                    }
                    catch (HttpRequestException) { }
                    catch (TaskCanceledException) when (!stoppingToken.IsCancellationRequested) { }
                    await Task.Delay(200, stoppingToken);
                }
                if (!healthy) throw new TimeoutException("Node health check timed out");
                await node.WaitForExitAsync(stoppingToken);
                logger.LogWarning("Node exited with {Code}; restarting", node.ExitCode);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                logger.LogError(error, "Node startup or supervision failed");
                if (!ready.Task.IsCompleted) ready.TrySetException(error);
            }
            finally
            {
                if (node is { HasExited: false }) node.Kill(entireProcessTree: true);
                node?.Dispose();
                node = null;
            }
            await Task.Delay(2000, stoppingToken);
        }
    }

    public override void Dispose()
    {
        // Closing the Windows Job also terminates Node if IIS terminates the worker unexpectedly.
        job?.Dispose();
        base.Dispose();
    }
}
