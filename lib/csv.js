var fs = require("fs");
var readline = require('readline');

var parseCodebook = require("./codebook");

// load bucket definitions
bucket_definitions = {};
fs.readdirSync(__dirname + "/../buckets/").forEach(function(d) {
	var buckets = require(__dirname + "/../buckets/" + d);
	Object.keys(buckets).forEach(function(bucket_key) {
		var bucket = buckets[bucket_key];
		if (bucket_definitions[bucket_key]) {
			console.log("Warning: two bucket files have the same key", bucket_key);
		}
		bucket_definitions[bucket_key] = bucket;
	});
});

module.exports = function(opts) {
	var codebook = fs.readFileSync(opts._[1] + ".cbk", "utf8"),
		instream = fs.createReadStream(opts._[1] + ".dat", { encoding: 'utf8' }),
		outstream = fs.createWriteStream(opts._[1] + ".tsv");

	/****** PARSE THE CODEBOOK *******/

	var cb = parseCodebook(codebook);

	var fields = cb.dictionary.map(function(d) { return d.Variable; });

	var buckets = [];

	var sql_statement = "CREATE TABLE `" + cb.description + "`(\n";

	opts.bucket = opts.bucket || opts.buckets;

	// this tracks fields from the original dataset that we need to bucket
	var fields_to_bucket = {};

	// if we're going to bucketize any vars, let's make fields for them.
	if (opts.bucket) {
		opts.bucket.split(",").forEach(function(bucket_name) {
			if (bucket_definitions[bucket_name]) {
				var bucket = bucket_definitions[bucket_name];
				// we'll use this to cache lookups in memory
				bucket.lookup = {};
				// some buckets apply to multiple fields, like HHINCOME and INCTOT

				// we want to catch this like EDUC_SP if there are joined attributes
				var bucket_fields = [bucket.field];
				if (~fields.indexOf(bucket.field + "_SP")) {
					bucket_fields.push(bucket.field + "_SP");
				}
				bucket_fields.forEach(function(field) {
					fields_to_bucket[field] = bucket;
					fields.push(field+"_bucketed");
				});
			} else {
				console.log("Couldn't find a bucket matching", bucket_name)
			}
		});
	}

	// fields to ignore in the output
	//var eliminate = ["DATANUM","PERNUM","GQ"];
	var eliminate = [];
	if (!opts.keep_original) {
		eliminate = eliminate.concat(Object.keys(fields_to_bucket));
	}
	if (opts.ignore) {
		eliminate = eliminate.concat(opts.ignore.split(","));
	}

	fields = fields.filter(function(d) { return eliminate.indexOf(d) == -1; });

	// check if we have the necessary fields for complete PUMAs
	if (opts.full_pumas) {
		if (!~fields.indexOf("STATEFIP") || (!~fields.indexOf("PUMA") && !~fields.indexOf("PUMASUPR"))) {
			console.log("For the --full_pumas option to work, you need to have both 'PUMA' and 'STATEFIP' in your original data request. Ignoring.");
			delete opts.full_pumas;
		}
	}

	// make a field for the PUMA area...
	var pumasJson = require("./pumas.json");
	fields.push("PUMAAREA");

	// now that we have our fields, we can construct the sql CREATE TABLE statement
	// it's not at all ideal to alot 64 characters for every field, but haven't written logic to figure out max size or type

	fields.forEach(function(field) {
		sql_statement += "`" + field + "` varchar(64) DEFAULT NULL,\n"
	});

	sql_statement = sql_statement.slice(0,-2); // nix final ","
	sql_statement += "\n) ENGINE=InnoDB DEFAULT CHARSET=utf8";

	fs.writeFileSync(opts._[1] + ".sql", sql_statement);

	outstream.write(fields.join("\t") + "\n");

	// read file line by line

	var buffer = "",
		total = 0,
		start = new Date().getTime(), // let's time the operation
		datum;

	var rl = readline.createInterface({
	    input: instream,
		output: process.stdout,
	    terminal: false
	});

	// read each line from the original .dat file and match it up to codebook
	rl.on('line', function(line) {
		datum = {};
		cb.dictionary.forEach(function(column) {
			// data from .dat file in relevant character ranges
			var valStr = line.slice(column.Columns[0]-1, column.Columns[1]);

			if (cb.definitions[column.Variable]) {
				// plain-language value of that variable, if found in codebook
				var	label = cb.definitions[column.Variable][valStr] || "N/A",
					// convert to native integer or float if pattern matches
					val = /^[0-9]+$/.test(label) ? parseInt(label,10) : (/^[0-9]+\.[0-9]+$/.test(label) ? parseFloat(label) : label);
			} else {
				var label = "",
					val = /^[0-9]+$/.test(valStr) ? parseInt(valStr,10) : (/^[0-9]+\.[0-9]+$/.test(valStr) ? parseFloat(valStr) : valStr); // convert to native integer or float if pattern matches
			}

			// some special cases to account for
			// PERWT and HHWT have two implicit decimals
			if (column.Variable === "PERWT" || column.Variable === "HHWT") {
				val /= 100;
			}

			// annoying thing they do with age
			if (column.Variable === "AGE") {
				val = parseInt(valStr);
			}

			datum[column.Variable] = { val: val, label: label, valStr: valStr };

		});

		if (opts.full_pumas) {
			if (datum.PUMA) {
				var full_puma = datum.STATEFIP.valStr + datum.PUMA.valStr;
				datum.PUMA = {
					val: full_puma,
					label: '', // we have these labels in pumas.json, but nowhere to currently put them in the output. (And would add hugely to filesize)
					valStr: full_puma
				};
				// add the puma area
				datum.PUMAAREA = {
					val: pumasJson[full_puma]["area"]
				};
			} else if (datum.PUMASUPR) {
				var full_puma = datum.PUMASUPR.valStr;
				datum.PUMASUPR = {
					val: full_puma,
					label: '', // we have these labels in pumas.json, but nowhere to currently put them in the output. (And would add hugely to filesize)
					valStr: full_puma
				};
			}
		}

		for (var field in fields_to_bucket) {
			if (!datum[field]) {
				//console.log(field);
				continue;
			}

			var bucket = fields_to_bucket[field],
				valStr = datum[field].valStr,
				field_name = field + "_bucketed";

			// check cache
			if (!bucket.lookup[valStr]) {
				var val = parseInt(valStr, 10),
					bucketed = false;

				for (var b in bucket.buckets) {
					if (val >= bucket.buckets[b][0] && val <= bucket.buckets[b][1]) {
						bucket.lookup[valStr] = bucket.buckets[b][2];
						bucketed = true;
						break;
					}
				}
				if (!bucketed) {
					bucket.lookup[valStr] = val;
				}
			}
			datum[field_name] = { val: bucket.lookup[valStr] };
			if (fields.indexOf(field) == -1) {
				delete datum[field];
			}
		}

		buffer += fields.map(function(d) { return datum[d].val; }).join("\t") + "\n";

		//console.log(datum);

		total += 1;

		if (total % 1000 === 0) {
			process.stdout.write("Scanned " + total + " lines\r");
		}

		if (total % (opts.buffer || 10000) === 0) {
			outstream.write(buffer);
			buffer = "";
		}
	});

	rl.on("close", function() {
		outstream.write(buffer);

		var end = new Date().getTime(),
			delta = Math.round((end - start) / 1000);

		console.log("Finished parsing " + total + " lines in " + delta + " seconds.");
		console.log("Wrote output to " + opts._[1] + ".tsv");
		console.log("Wrote SQL CREATE TABLE statement to", opts._[1] + ".sql");

	});
}
