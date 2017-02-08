/*
 * CDDL HEADER START
 *
 * The contents of this file are subject to the terms of the
 * Common Development and Distribution License, Version 1.0 only
 * (the "License").  You may not use this file except in compliance
 * with the License.
 *
 * You can obtain a copy of the license at http://smartos.org/CDDL
 *
 * See the License for the specific language governing permissions
 * and limitations under the License.
 *
 * When distributing Covered Code, include this CDDL HEADER in each
 * file.
 *
 * If applicable, add the following below this CDDL HEADER, with the
 * fields enclosed by brackets "[]" replaced with your own identifying
 * information: Portions Copyright [yyyy] [name of copyright owner]
 *
 * CDDL HEADER END
 *
 * Copyright 2017, Joyent, Inc.
 */

var assert = require('assert');
var execFile = require('child_process').execFile;
var fs = require('fs');
var path = require('path');
var util = require('util');

var async = require('/usr/node/node_modules/async');
var bunyan = require('/usr/vm/node_modules/bunyan');
var vasync = require('/usr/vm/node_modules/vasync');

// this puts test stuff in global, so we need to tell jsl about that:
/* jsl:import ../node_modules/nodeunit-plus/index.js */
require('/usr/vm/node_modules/nodeunit-plus');

var FsWatcher = require('/usr/vm/node_modules/vminfod/fswatcher').FsWatcher;
var log = bunyan.createLogger({
    level: 'error',
    name: 'fswatcher-test-dummy',
    streams: [ { stream: process.stderr, level: 'error' } ],
    serializers: bunyan.stdSerializers
});
var testdir = path.join('/tmp', 'test-fswatcher-' + process.pid);

test('try creating temp directory', function (t) {
    execFile('/usr/bin/mkdir', ['-p', testdir], function (err, stdout, stderr) {
        assert(!err);
        t.end();
    });
});

test('try starting and stopping watcher', function (t) {
    var fsw = new FsWatcher({log: log});
    t.ok(fsw, 'created watcher');
    t.ok(fsw.stopped, 'watcher not running');

    fsw.once('ready', function () {
        t.ok(!fsw.stopped, 'watcher running');
        fsw.stop();
        t.end();
    });

    fsw.start();
});

test('try starting already running watcher', function (t) {
    var fsw = new FsWatcher({log: log});
    t.ok(fsw, 'created watcher');

    fsw.once('ready', function () {
        t.ok(!fsw.stopped, 'watcher running');
        t.throws(function () {
            fsw.start();
        }, null, 'start twice');

        fsw.stop();
        t.end();
    });

    fsw.start();
});

test('try stopping a stopped watcher', function (t) {
    var fsw = new FsWatcher({log: log});
    t.ok(fsw, 'created watcher');
    t.ok(fsw.stopped, 'watcher not running');

    t.throws(function () {
        fsw.stop();
    }, null, 'stop stopped');

    t.end();
});

test('try watching files with illegal characters', function (t) {
    var fsw = new FsWatcher({log: log});


    fsw.once('ready', function () {
        vasync.forEachPipeline({
            inputs: ['newline\nchar', 'nulbyte\0char'],
            func: function (f, cb) {
                fsw.watch(f, function (err) {
                    t.ok(err, 'error is expected: '
                        + JSON.stringify((err || {}).message));
                    cb();
                });
            }
        }, function (err) {
            fsw.stop();
            t.end();
        });
    });

    fsw.start();
});

test('try watching an existent file and catching CHANGE and DELETE',
    function (t) {
        var filename = path.join(testdir, 'hello.txt');
        var saw_change = false;
        var saw_delete = false;

        var fsw = new FsWatcher({log: log});

        fs.writeFileSync(filename, 'hello world\n');
        t.ok(fs.existsSync(filename), 'file was created');

        fsw.on('delete', function (evt) {
            t.equal(evt.pathname, filename, 'delete was for correct filename');
            t.ok(saw_change, 'at delete time, already saw change');
            saw_delete = true;
            cleanup();
        });

        fsw.on('change', function (evt) {
            t.equal(evt.pathname, filename, 'change was for correct filename');
            t.ok(!saw_delete, 'at change time, did not yet see delete');
            if (!saw_change) {
                // avoid doing twice if there are multiple changes
                saw_change = true;
                fs.unlinkSync(filename); // should trigger DELETE
            }
        });

        fsw.once('ready', function (evt) {
            fsw.watch(filename, watchcb);
        });

        fsw.start();

        function watchcb(err) {
            t.ok(!err, (err ? err.message : 'started watching ' + filename));
            if (err) {
                cleanup();
                return;
            }

            // should trigger CHANGE
            fs.writeFileSync(filename, 'goodbye world\n');
        }

        function cleanup() {
            fsw.unwatch(filename, function () {
                fsw.stop();
                t.ok(saw_change, 'saw change event at cleanup');
                t.ok(saw_delete, 'saw delete event at cleanup');
                t.end();
            });
        }
    }
);

test('try watching a non-existent file then create it', function (t) {
    var filename = path.join(testdir, '/file/that/shouldnt/exist.txt');
    var dirname = path.dirname(filename);
    var saw_create = false;

    var fsw = new FsWatcher({log: log});

    fsw.once('ready', function (evt) {
        vasync.pipeline({funcs: [
            function (_, cb) {
                fsw.watch(filename, cb);
            }, function (_, cb) {
                // create directory
                execFile('/usr/bin/mkdir', ['-p', dirname],
                    function (err, stdout, stderr) {
                        t.ok(!err, 'mkdir -p ' + dirname);
                        cb(err);
                    }
                );
            }, function (_, cb) {
                t.ok(!saw_create, 'haven\'t seen "create" event yet');
                // create file
                fs.writeFile(filename, 'hello world\n', function (err) {
                    t.ok(!err, 'wrote "hello world" to ' + filename);
                    cb(err);
                });
            }
        ]}, function (err) {
            if (err) {
                t.ok(!err, err.message);
                cleanup();
            }
        });
    });

    fsw.on('create', function (evt) {
        t.equal(evt.pathname, filename, 'saw create event for ' + filename);
        saw_create = true;
        cleanup();
    });

    fsw.start();

    function cleanup() {
        fsw.unwatch(filename, function () {
            fsw.stop();
            t.ok(saw_create, 'saw create event at cleanup');
            t.end();
        });
    }
});

test('try watching an existent file, unwatching and ensure no events',
    function (t) {

    var events_after_stop = 0;
    var filename = path.join(testdir, 'tricky.txt');
    var saw_change = false;
    var stopped_watching = false;

    var fsw = new FsWatcher({log: log});

    fs.writeFileSync(filename, 'look at me, I\'m so tricky!\n');
    t.ok(fs.existsSync(filename), 'file was created');

    fsw.on('event', function (evt) {
        if (stopped_watching) {
            events_after_stop++;
        }
    });

    fsw.on('change', function (evt) {
        t.equal(evt.pathname, filename, 'change was for correct filename');
        t.ok(!stopped_watching, 'when change event happened, we have not '
            + 'stopped watching');

        // avoid doing twice if there are multiple changes
        if (saw_change)
            return;

        saw_change = true;

        if (stopped_watching)
            return;

        fsw.unwatch(filename, function () {
            stopped_watching = true;

            // would trigger DELETE, but we shouldn't get it.
            fs.unlinkSync(filename);

            // leave some time for rogue events to show up
            setTimeout(function () {
                fsw.stop();
                t.equal(events_after_stop, 0, 'should not see events '
                    + 'after stopping');
                t.end();
            }, 2000);
        });
    });

    fsw.once('ready', function (evt) {
        fsw.watch(filename, function (err) {
            fs.writeFileSync(filename, 'now we are writing junk!\n');
            // now change event should have been triggered and we should
            //  have stopped watcher. Control should pass to
            // fsw.on('change'... above.
            return;
        });
    });

    fsw.start();
});

test('create a file and ensure we get multiple modify events',
    function (t) {

    var changes = 0;
    var filename = path.join(testdir, 'changeme.txt');

    var fsw = new FsWatcher({log: log});

    fs.writeFileSync(filename, 'initial data\n');
    t.ok(fs.existsSync(filename), 'file was created');

    fsw.on('event', function (evt) {
        t.ok(evt.changes.indexOf('FILE_MODIFIED') > -1,
            'type of "event" event is "change"');
    });

    fsw.on('change', function (evt) {
        t.equal(evt.pathname, filename, 'change was for correct filename');
        changes++;
        if (changes > 0) {
            fsw.stop();
            t.end();
        }
    });

    fsw.once('ready', function (evt) {
        fsw.watch(filename, function (err) {
            fs.writeFileSync(filename, 'first modification!\n');
            return;
        });
    });

    fsw.start();
});

test('watch 10000 non-existent files, create them, modify them and delete them',
    function (t) {

    var then = new Date();

    var count = 10000;
    var fsw = new FsWatcher({log: log});
    var files = [];

    // events seen per file
    var events = {};

    // events seen
    var seen = {
        create: 0,
        change: 0,
        delete: 0
    };

    // array of filenames to watch and manage
    for (var i = 0; i < count; i++) {
        var filename = path.join(testdir, 'testfile.' + i);
        files.push(filename);
        events[filename] = [];
    }

    // Because we are managing a large number of files, a vasync queue is used
    // to manage all file creations, modifications, and deletions.
    var q = vasync.queue(function (task, cb) {
        task(cb);
    }, 100);

    // deadman switch - we stop this if it takes too long
    var timeout = setTimeout(function () {
        var e = new Error('timeout exceeded');
        cleanup(e);
    }, 60 * 1000);

    vasync.pipeline({funcs: [
        function (_, cb) {
            // start the FsWatcher
            fsw.once('ready', function (evt) {
                cb();
            });
            fsw.start();
        }, function (_, cb) {
            // start watching for events
            var done = 0;

            fsw.on('create', function (evt) {
                if (!evt.pathname.match(/\/testfile.[0-9]+$/)) {
                    log.error({evt: evt},
                        'throwing out event for file %s',
                        evt.pathname);
                    return;
                }

                seen.create++;
                events[evt.pathname].push('create-seen');

                // modify the file - triggers 'change' event
                q.push(function (cb2) {
                    events[evt.pathname].push('change');
                    fs.truncate(evt.pathname, 0, cb2);
                });
            });

            fsw.on('change', function (evt) {
                if (!evt.pathname.match(/\/testfile.[0-9]+$/)) {
                    log.error({evt: evt},
                        'throwing out event for file %s',
                        evt.pathname);
                    return;
                }

                if (events[evt.pathname].indexOf('change-seen') > -1) {
                    log.error({evt: evt},
                        'change event already seen for file %s',
                        evt.pathname);
                    return;
                }

                seen.change++;
                events[evt.pathname].push('change-seen');

                // delete the file - triggers 'delete' event
                q.push(function (cb2) {
                    events[evt.pathname].push('delete');
                    fs.unlink(evt.pathname, cb2);
                });
            });

            fsw.on('delete', function (evt) {
                if (!evt.pathname.match(/\/testfile.[0-9]+$/)) {
                    log.error({evt: evt},
                        'throwing out event for file %s',
                        evt.pathname);
                    return;
                }

                seen.delete++;
                events[evt.pathname].push('delete-seen');

                fsw.unwatch(evt.pathname, function () {
                    delete events[evt.pathname];
                    // check if we're done
                    if (++done === count) {
                        clearTimeout(timeout);
                        cleanup();
                    }
                });
            });

            cb();
        }, function (_, cb) {
            // add watches for all non-existent files
            vasync.forEachParallel({
                func: function (f, cb2) {
                    events[f].push('watch');
                    fsw.watch(f, cb2);
                },
                inputs: files
            }, function (err) {
                t.ok(!err, (err ? err.message : 'no errors'));
                cb();
            });
        }, function (_, cb) {
            // all files are being watched, create them
            vasync.forEachParallel({
                func: function (f, cb2) {
                    q.push(function (cb3) {
                        var data = 'foo ' + f;
                        fs.writeFile(f, data, function (err) {
                            events[f].push('create');
                            cb3(err); // tell queue we're done
                            cb2(err); // tell forEachParallel we're done
                        });
                    });
                },
                inputs: files
            }, function (err) {
                t.ok(!err, (err ? err.message : 'no errors'));
                cb();
            });
        }
    ]}, function (err) {
        // control is passed onto fsw events now
    });

    function cleanup(err) {
        var now = new Date();
        var delta = now - then;
        t.ok(!err, (err ? err.message : 'no errors'));
        t.ok(true, 'took ' + delta + 'ms to complete');

        Object.keys(seen).forEach(function (ev) {
            t.equal(seen[ev], count,
                util.format('have seen %d / %d %s events',
                seen[ev], count, ev));
        });

        var keys = Object.keys(events);
        t.equal(keys.length, 0, '0 files left');
        if (keys.length > 0) {
            console.error(events);
        }

        fsw.status(function (_, obj) {
            if (err) {
                log.error({obj: obj}, 'fswatcher status before exit');
            }
            fsw.stop();
            t.end();
        });
    }
});

test('cleanup', function (t) {
    t.ok(true, 'cleaning up');
    execFile('/usr/bin/rm', ['-rf', testdir],
        function (err, stdout, stderr) {
            t.ok(!err, (err ? err.message : 'cleaned up'));
            t.end();
        }
    );
});
