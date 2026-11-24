using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

var target = args[0];
var filter = args.Length > 1 ? args[1] : "";
var files = File.Exists(target)
    ? new[] { target }
    : Directory.EnumerateFiles(target, "*.dll").ToArray();

foreach (var file in files)
{
    try
    {
        using var fs = File.OpenRead(file);
        using var pe = new PEReader(fs);
        if (!pe.HasMetadata) continue;
        var md = pe.GetMetadataReader();
        foreach (var handle in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(handle);
            var name = md.GetString(td.Name);
            if (!name.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
            Console.WriteLine($"TYPE {Path.GetFileName(file)} :: {md.GetString(td.Namespace)}.{name}");
            foreach (var mh in td.GetMethods())
            {
                var m = md.GetMethodDefinition(mh);
                Console.WriteLine($"  METHOD {md.GetString(m.Name)}");
            }
            foreach (var fh in td.GetFields())
            {
                var f = md.GetFieldDefinition(fh);
                Console.WriteLine($"  FIELD {md.GetString(f.Name)}");
            }
        }
    }
    catch { }
}
