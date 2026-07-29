#lang racket/base

(require json
         racket/cmdline
         racket/file
         racket/format
         racket/path
         racket/runtime-path
         racket/string
         racket/system)

(define target #f)
(define release-version #f)
(define commit "working-tree")

(command-line
 #:program "build-distribution.rkt"
 #:once-each
 [("--target") value
  "Artifact target name, such as aarch64-macos"
  (set! target value)]
 [("--version") value
  "Version embedded in the artifact filename"
  (set! release-version value)]
 [("--commit") value
  "Source commit recorded in the evidence file"
  (set! commit value)]
 #:args ()
 (void))

(unless target
  (raise-user-error 'build-distribution "--target is required"))
(unless release-version
  (raise-user-error 'build-distribution "--version is required"))

(define-runtime-path scripts-directory ".")
(define racket-root
  (simplify-path (build-path scripts-directory 'up)))
(define repository-root
  (simplify-path (build-path racket-root 'up)))
(define entry-point
  (build-path racket-root "marionette" "main.rkt"))
(define artifacts-directory
  (build-path racket-root "artifacts"))
(define stem
  (format "marionette-~a-~a" release-version target))
(define archive
  (build-path artifacts-directory (string-append stem ".tar.gz")))
(define evidence
  (build-path artifacts-directory (string-append stem ".json")))
(define temporary-root
  (make-temporary-file "marionette-distribution~a" 'directory))
(define executable
  (build-path temporary-root "marionette"))
(define distribution
  (build-path temporary-root stem))

(define raco
  (or (find-executable-path "raco")
      (raise-user-error 'build-distribution "raco is not on PATH")))
(define tar
  (or (find-executable-path "tar")
      (raise-user-error 'build-distribution "tar is not on PATH")))

(define (run! program . arguments)
  (unless (apply system* program arguments)
    (raise-user-error
     'build-distribution
     "command failed: ~a ~a"
     program
     (string-join arguments " "))))

(define (elapsed-ms started)
  (inexact->exact
   (round (- (current-inexact-milliseconds) started))))

(make-directory* artifacts-directory)
(when (file-exists? archive)
  (delete-file archive))

(dynamic-wind
 void
 (lambda ()
   (define build-started (current-inexact-milliseconds))
   (run! raco "exe" "-o" (path->string executable) (path->string entry-point))
   (run! raco
         "distribute"
         (path->string distribution)
         (path->string executable))
   (define build-ms (elapsed-ms build-started))

   (copy-file
    (build-path racket-root "README.md")
    (build-path distribution "README.md")
    #t)
   (copy-file
    (build-path racket-root "DISTRIBUTION.md")
    (build-path distribution "DISTRIBUTION.md")
    #t)

   (define smoke-executable
     (build-path distribution "bin" "marionette"))
   (unless (file-exists? smoke-executable)
     (raise-user-error
      'build-distribution
      "assembled executable is missing: ~a"
      smoke-executable))

   (define startup-started (current-inexact-milliseconds))
   (run! smoke-executable "--version")
   (define startup-ms (elapsed-ms startup-started))

   (run! tar
         "-czf"
         (path->string archive)
         "-C"
         (path->string temporary-root)
         stem)

   (call-with-output-file
    evidence
    #:exists 'truncate/replace
    (lambda (out)
      (write-json
       (hasheq
        'schema 1
        'artifact (path->string (file-name-from-path archive))
        'artifactBytes (file-size archive)
        'buildMilliseconds build-ms
        'commit commit
        'racketVersion (version)
        'startupMilliseconds startup-ms
        'target target
        'version release-version)
       out)
      (newline out)))

   (printf "archive: ~a\n" archive)
   (printf "evidence: ~a\n" evidence))
 (lambda ()
   (when (directory-exists? temporary-root)
     (delete-directory/files temporary-root))))
