// Licensed under the Apache License, Version 2.0 (the "License"); you may not
// use this file except in compliance with the License. You may obtain a copy of
// the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
// WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
// License for the specific language governing permissions and limitations under
// the License.

couchTests.elixir = true;
couchTests.view_errors = function(debug) {
  var db_name = get_random_db_name();
  var db = new CouchDB(db_name, {"X-Couch-Full-Commit":"false"});
  db.createDb();
  if (debug) debugger;

  // run_on_modified_server(
  //   [{section: "couchdb",
  //     key: "os_process_timeout",
  //     value: "500"}],
  //   function() {
      var doc = {integer: 1, string: "1", array: [1, 2, 3]};
      T(db.save(doc).ok);

      // emitting a key value that is undefined should result in that row
      // being included in the view results as null
      var results = db.query(function(doc) {
        emit(doc.undef, null);
      });
      T(results.total_rows == 1);
      T(results.rows[0].key == null);

      // if a view function throws an exception, its results are not included in
      // the view index, but the view does not itself raise an error
      var results = db.query(function(doc) {
        doc.undef(); // throws an error
      });
      T(results.total_rows == 0);

      // if a view function includes an undefined value in the emitted key or
      // value, it is treated as null
      var results = db.query(function(doc) {
        emit([doc._id, doc.undef], null);
      });
      T(results.total_rows == 1);
      T(results.rows[0].key[1] == null);
      
      // querying a view with invalid params should give a resonable error message
      var xhr = CouchDB.request("POST", "/" + db_name + "/_all_docs?startkey=foo", {
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({language: "javascript",
          map : "function(doc){emit(doc.integer)}"
        })
      });
      T(JSON.parse(xhr.responseText).error == "bad_request");

      // content type must be json
      var xhr = CouchDB.request("POST", "/" + db_name + "/_all_docs", {
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: JSON.stringify({language: "javascript",
          map : "function(doc){}"
        })
      });
      T(xhr.status == 415);

      var map = function (doc) {emit(doc.integer, doc.integer);};

      try {
          db.query(map, null, {group: true});
          T(0 == 1);
      } catch(e) {
          T(e.error == "query_parse_error");
      }

      var designDoc = {
        _id:"_design/test",
        language: "javascript",
        views: {
          "no_reduce": {map:"function(doc) {emit(doc._id, null);}"},
          "with_reduce": {
            map:"function (doc) {emit(doc.integer, doc.integer)};",
            reduce:"function (keys, values) { return sum(values); };"}
        }
      };
      T(db.save(designDoc).ok);

      var designDoc2 = {
        _id:"_design/testbig",
        language: "javascript",
        views: {
          "reduce_too_big"  : {
            map:"function (doc) {emit(doc.integer, doc.integer)};",
            reduce:"function (keys, values) { var chars = []; for (var i=0; i < 1000; i++) {chars.push('wazzap');};return chars; };"}
        }
      };
      T(db.save(designDoc2).ok);

      try {
          db.view("test/no_reduce", {group: true});
          T(0 == 1);
      } catch(e) {
          T(db.last_req.status == 400);
          T(e.error == "query_parse_error");
      }

      try {
          db.view("test/no_reduce", {group_level: 1});
          T(0 == 1);
      } catch(e) {
          T(db.last_req.status == 400);
          T(e.error == "query_parse_error");
      }

      try {
        db.view("test/no_reduce", {reduce: true});
        T(0 == 1);
      } catch(e) {
        T(db.last_req.status == 400);
        T(e.error == "query_parse_error");
      }

      db.view("test/no_reduce", {reduce: false});
      TEquals(200, db.last_req.status, "reduce=false for map views (without"
                                     + " group or group_level) is allowed");

      try {
          db.view("test/with_reduce", {group: true, reduce: false});
          T(0 == 1);
      } catch(e) {
          T(db.last_req.status == 400);
          T(e.error == "query_parse_error");
      }

      try {
          db.view("test/with_reduce", {group_level: 1, reduce: false});
          T(0 == 1);
      } catch(e) {
        T(db.last_req.status == 400);
          T(e.error == "query_parse_error");
      }

      var designDoc3 = {
        _id:"_design/infinite",
        language: "javascript",
        views: {
          "infinite_loop" :{map:"function(doc) {while(true){emit(doc,doc);}};"}
        }
      };
      T(db.save(designDoc3).ok);

      try {
          db.view("infinite/infinite_loop");
          T(0 == 1);
      } catch(e) {
          // This test has two different races. The first is whether
          // the while loop exhausts the JavaScript RAM limits before
          // timing. The second is a race between which of two timeouts
          // fires first. The first timeout is the couch_os_process
          // waiting for data back from couchjs. The second is the
          // gen_server call to couch_os_process.
          T(e.error == "os_process_error" || e.error == "timeout");
      }

      // Check error responses for invalid multi-get bodies.
      var path = "/" + db_name + "/_design/test/_view/no_reduce";
      var xhr = CouchDB.request("POST", path, {body: "[]"});
      T(xhr.status == 400);
      result = JSON.parse(xhr.responseText);
      T(result.error == "bad_request");
      T(result.reason == "Request body must be a JSON object");
      var data = "{\"keys\": 1}";
      xhr = CouchDB.request("POST", path, {body:data});
      T(xhr.status == 400);
      result = JSON.parse(xhr.responseText);
      T(result.error == "bad_request");
      T(result.reason == "`keys` member must be an array.");

      // if the reduce grows to fast, throw an overflow error
      var path = "/" + db_name + "/_design/testbig/_view/reduce_too_big";
      xhr = CouchDB.request("GET", path);
      T(xhr.status == 200);
      result = JSON.parse(xhr.responseText);
      T(result.rows[0].error == "reduce_overflow_error");

      try {
          db.query(function() {emit(null, null)}, null, {startkey: 2, endkey:1});
          T(0 == 1);
      } catch(e) {
          T(e.error == "query_parse_error");
          T(e.reason.match(/no rows can match/i));
      }

      // querying a temporary view should give "gone" error message
      var xhr = CouchDB.request("POST", "/" + db_name + "/_temp_view", {
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({language: "javascript",
          map : "function(doc){emit(doc.integer)}"
        })
      });
      T(xhr.status == 410);
      result = JSON.parse(xhr.responseText);
      T(result.error == "gone");
      T(result.reason == "Temporary views are not supported in CouchDB");
    // });

  // cleanup
  db.deleteDb();
};
