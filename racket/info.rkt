#lang info

(define collection 'multi)
(define version "0.0")
(define deps '("base" "datalog" "racklog"))
(define build-deps '("rackunit-lib"))
(define pkg-desc
  "Learning-first seed for Marionette's human-owned Racket implementation")
(define pkg-authors '("Lee Meichin"))
(define test-omit-paths '("scripts"))
